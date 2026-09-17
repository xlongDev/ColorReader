//! Reading time: one row per (local day, book), rolled up for the heat map.
//!
//! The reader reports elapsed seconds in batches and this module accumulates
//! them. Nothing reconstructs a "session" from timestamps: a reader who opens
//! a book twelve times in a day gets one row that grows, which is exactly what
//! the heat map wants and a fraction of the storage a session log would cost.
//!
//! Days are local calendar days, formatted `YYYY-MM-DD`. The heat map and the
//! streak both count calendar days, so the offset has to be the reader's, and
//! only the machine running the app knows it.

use std::collections::HashMap;

use chrono::{Duration, Local};
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::AppResult;

/// Reading time for one calendar day.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    /// Local day, `YYYY-MM-DD`.
    pub day: String,
    pub seconds: i64,
}

/// Everything the stats page draws.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    /// Today, local time.
    pub today_seconds: i64,
    /// The last seven days, today included.
    pub week_seconds: i64,
    pub total_seconds: i64,
    /// Consecutive days with reading time ending today or yesterday. Zero on a
    /// gap: a streak that only survives until midnight would read as a bug.
    pub streak: i64,
    /// Distinct days ever read, the honest denominator behind the total.
    pub days_read: i64,
    /// The trailing `window` days, oldest first, gaps filled with zeroes so the
    /// heat map never has to do date arithmetic.
    pub days: Vec<DayTotal>,
}

/// Today in the machine's timezone, `YYYY-MM-DD`.
pub fn local_day() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Adds `seconds` to today's row for `book_id`.
///
/// Non-positive amounts are ignored rather than rejected: the reader's flush
/// timer can fire on a tab that never had focus, and an empty batch is not an
/// error worth surfacing.
pub fn record_session(conn: &Connection, book_id: &str, seconds: i64) -> AppResult<()> {
    if seconds <= 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO reading_sessions (day, book_id, seconds) VALUES (?1, ?2, ?3)
         ON CONFLICT (day, book_id) DO UPDATE SET seconds = seconds + excluded.seconds",
        params![local_day(), book_id, seconds],
    )?;
    Ok(())
}

/// Rolls the table up into [`ReadingStats`] over the trailing `window` days.
pub fn reading_stats(conn: &Connection, window: usize) -> AppResult<ReadingStats> {
    let per_day = totals_by_day(conn)?;
    let today = Local::now().date_naive();
    let days = trailing_days(&per_day, today, window);

    let today_key = today.format("%Y-%m-%d").to_string();
    let today_seconds = per_day.get(&today_key).copied().unwrap_or(0);
    let week_seconds = days.iter().rev().take(7).map(|day| day.seconds).sum();
    let total_seconds = per_day.values().sum();
    let streak = streak(&per_day, today);

    Ok(ReadingStats {
        today_seconds,
        week_seconds,
        total_seconds,
        streak,
        days_read: per_day.len() as i64,
        days,
    })
}

fn totals_by_day(conn: &Connection) -> AppResult<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT day, SUM(seconds) FROM reading_sessions GROUP BY day")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    let mut totals = HashMap::new();
    for row in rows {
        let (day, seconds) = row?;
        totals.insert(day, seconds);
    }
    Ok(totals)
}

fn trailing_days(
    totals: &HashMap<String, i64>,
    today: chrono::NaiveDate,
    window: usize,
) -> Vec<DayTotal> {
    (0..window)
        .rev()
        .filter_map(|back| today.checked_sub_signed(Duration::days(back as i64)))
        .map(|date| DayTotal {
            seconds: totals.get(&date.format("%Y-%m-%d").to_string()).copied().unwrap_or(0),
            day: date.format("%Y-%m-%d").to_string(),
        })
        .collect()
}

/// Days read backwards from today, or from yesterday when today has none yet.
fn streak(totals: &HashMap<String, i64>, today: chrono::NaiveDate) -> i64 {
    let mut cursor = today;
    if !totals.contains_key(&cursor.format("%Y-%m-%d").to_string()) {
        cursor = match cursor.checked_sub_signed(Duration::days(1)) {
            Some(yesterday) if totals.contains_key(&yesterday.format("%Y-%m-%d").to_string()) => {
                yesterday
            }
            _ => return 0,
        };
    }
    let mut count = 0;
    while totals.contains_key(&cursor.format("%Y-%m-%d").to_string()) {
        count += 1;
        cursor = match cursor.checked_sub_signed(Duration::days(1)) {
            Some(day) => day,
            None => break,
        };
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    /// 26 weeks, the width of a GitHub-style heat map.
    const WINDOW: usize = 182;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'txt', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn
    }

    /// Writes a row for a day relative to today, bypassing `record_session`'s
    /// "today only" rule so the streak can be built out of the past.
    fn record_on(conn: &Connection, back: i64, seconds: i64) {
        let day = Local::now()
            .date_naive()
            .checked_sub_signed(Duration::days(back))
            .expect("date")
            .format("%Y-%m-%d")
            .to_string();
        conn.execute(
            "INSERT INTO reading_sessions (day, book_id, seconds) VALUES (?1, 'b', ?2)",
            params![day, seconds],
        )
        .expect("insert session");
    }

    #[test]
    fn batches_accumulate_instead_of_overwriting() {
        let conn = seed();
        record_session(&conn, "b", 60).expect("first");
        record_session(&conn, "b", 90).expect("second");
        let stats = reading_stats(&conn, WINDOW).expect("stats");
        assert_eq!(stats.today_seconds, 150);
    }

    #[test]
    fn empty_and_negative_batches_are_ignored() {
        let conn = seed();
        record_session(&conn, "b", 0).expect("zero");
        record_session(&conn, "b", -30).expect("negative");
        assert_eq!(reading_stats(&conn, WINDOW).expect("stats").today_seconds, 0);
    }

    #[test]
    fn the_window_is_filled_with_zero_days() {
        let conn = seed();
        let stats = reading_stats(&conn, 30).expect("stats");
        assert_eq!(stats.days.len(), 30);
        assert!(stats.days.iter().all(|day| day.seconds == 0));
        // Oldest first, so the heat map can render top-left to bottom-right.
        assert!(stats.days[0].day < stats.days[29].day);
    }

    #[test]
    fn the_streak_counts_backwards_and_forgives_today() {
        let conn = seed();
        record_on(&conn, 0, 100);
        record_on(&conn, 1, 100);
        record_on(&conn, 2, 100);
        assert_eq!(reading_stats(&conn, WINDOW).expect("stats").streak, 3);

        let conn = seed();
        // Nothing today yet, but yesterday counts: a streak must not die
        // because the reader has not opened a book this morning.
        record_on(&conn, 1, 100);
        record_on(&conn, 2, 100);
        assert_eq!(reading_stats(&conn, WINDOW).expect("stats").streak, 2);
    }

    #[test]
    fn a_gap_breaks_the_streak() {
        let conn = seed();
        record_on(&conn, 0, 100);
        record_on(&conn, 2, 100);
        assert_eq!(reading_stats(&conn, WINDOW).expect("stats").streak, 1);
    }

    #[test]
    fn totals_span_the_whole_table_not_the_window() {
        let conn = seed();
        record_on(&conn, 0, 60);
        // Older than any window the UI asks for, still part of the lifetime sum.
        record_on(&conn, 900, 60);
        let stats = reading_stats(&conn, 7).expect("stats");
        assert_eq!(stats.total_seconds, 120);
        assert_eq!(stats.week_seconds, 60);
        assert_eq!(stats.days_read, 2);
    }
}
