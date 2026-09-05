//! Repeatable release benchmarks, kept behind `#[ignore]` so they never run in
//! the ordinary gate:
//!
//! ```text
//! cargo test --release --manifest-path src-tauri/Cargo.toml bench -- --ignored --nocapture
//! ```
//!
//! Numbers land in README. The workload mirrors the reference book used since
//! Phase 5: 600 chapters / ~828k Chinese characters, i.e. a long web novel.

#![cfg(test)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::chapters;
use super::import;
use super::search;
use crate::db::{Layout, Library};
use crate::document::fixture::temp_dir;

const CHAPTERS: usize = 600;
const PARAS_PER_CHAPTER: usize = 28;

/// Builds the reference TXT: `第N章` markers drive the chapter splitter.
fn write_reference_txt(dir: &std::path::Path) -> PathBuf {
    let mut text = String::with_capacity(900_000);
    for chapter in 1..=CHAPTERS {
        text.push_str(&format!("第{chapter}章 风起第{chapter}回\n"));
        for para in 0..PARAS_PER_CHAPTER {
            text.push_str(&format!(
                "段落{para}：山雨欲来，江湖夜雨十年灯，桃李春风一杯酒。\
                 少年握紧手中剑，望向远方沉沉的暮色，胸中块垒化作一声长啸。\n"
            ));
        }
    }
    let path = dir.join("bench-book.txt");
    std::fs::write(&path, text).expect("write bench txt");
    path
}

struct Bench {
    dir: PathBuf,
}

impl Bench {
    fn new(tag: &str) -> Self {
        let dir = temp_dir(tag);
        Self { dir }
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn ms(elapsed: Duration) -> f64 {
    elapsed.as_secs_f64() * 1000.0
}

#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn large_book_pipeline_bench() -> Result<(), Box<dyn std::error::Error>> {
    let bench = Bench::new("bench-pipeline");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    let source = write_reference_txt(&bench.dir);
    let bytes = std::fs::metadata(&source).expect("stat").len();
    println!("\nreference book: {CHAPTERS} chapters, {bytes} bytes");

    let started = Instant::now();
    let outcomes = import::import_files(
        &library,
        &layout,
        std::slice::from_ref(&source),
        None,
        &mut |_, _, _| {},
    );
    let import_ms = ms(started.elapsed());
    let book_id = match &outcomes[0] {
        import::ImportOutcome::Imported { id, .. } => id.clone(),
        other => panic!("期望导入成功，实际 {other:?}"),
    };

    // The import triggers already populated chapters_fts; measure a warm query
    // and a cold-ish one (different needle) over the whole library.
    let warmed = (0..20)
        .map(|i| {
            let started = Instant::now();
            let hits = library
                .with(|conn| {
                    search::query(conn, if i % 2 == 0 { "江湖夜雨" } else { "十年灯" }, None, 50)
                })
                .expect("search");
            assert!(!hits.is_empty());
            ms(started.elapsed())
        })
        .sum::<f64>()
        / 20.0;

    // Chapter list is what the reader TOC loads on every book open.
    let toc_ms = {
        let started = Instant::now();
        let meta = chapters::ensure(&library, &book_id).expect("chapters");
        assert_eq!(meta.len(), CHAPTERS);
        ms(started.elapsed())
    };

    println!("import (split + FTS index): {import_ms:.1} ms");
    println!("search query avg (20 runs): {warmed:.2} ms");
    println!("toc chapter list:           {toc_ms:.1} ms");
    Ok(())
}
