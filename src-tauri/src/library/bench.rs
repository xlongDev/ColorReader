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

/// 400 pages is enough for the per-page decode to dominate; the ratio, not the
/// absolute number, is the thing this pins.
const PDF_PAGES: usize = 400;

/// The reference PDF. Latin text on purpose: the fixture's font has no
/// ToUnicode map, so a CJK literal would come back as noise and make the
/// "text is non-empty" assertion meaningless.
fn write_reference_pdf(dir: &std::path::Path) -> PathBuf {
    let pages: Vec<String> = (1..=PDF_PAGES)
        .map(|page| {
            format!("Page {page}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.")
        })
        .collect();
    let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
    crate::document::fixture::write_pdf(dir, "bench-book.pdf", &refs, Some("Bench PDF"))
}

/// What deferring a PDF's text extraction actually buys.
///
/// The two numbers are the point: `import` is what the shelf waits for, and it
/// is the page index only. `backfill` is the per-page decode, and it happens
/// after the import has already answered.
///
/// ⚠️ The ratio here understates the real one badly, and the fixture is why:
/// it is hand-built with one font and no ToUnicode map, so the decode is nearly
/// free. On a real 756-page / 21 MB file the split was 974 ms of 2.1 s — 98% of
/// the import. Read this bench for the shape, not the magnitude.
#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn pdf_import_bench() -> Result<(), Box<dyn std::error::Error>> {
    let bench = Bench::new("bench-pdf");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    let source = write_reference_pdf(&bench.dir);
    println!("\nreference pdf: {PDF_PAGES} pages");

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

    // The import owes the text, and says so; this is the assertion that would
    // fail if the deferral silently turned into a loss.
    let index = library.with(|conn| chapters::list(conn, &book_id))?;
    assert_eq!(index.len(), PDF_PAGES, "导入必须落好页索引");
    assert!(index.iter().all(|chapter| chapter.chars == 0), "导入不得抽正文");

    // What the reader pays on a first open: the TOC of a book whose text is
    // still owed. It has to be the index read and nothing more — routing the
    // backfill through here once put a whole decode in front of "正在打开…".
    let started = Instant::now();
    let meta = chapters::ensure(&library, &book_id).expect("chapters");
    let toc_ms = ms(started.elapsed());
    assert_eq!(meta.len(), PDF_PAGES);
    assert!(meta.iter().all(|chapter| chapter.chars == 0), "读目录不许顺手补正文");

    let started = Instant::now();
    chapters::backfill(&library, &book_id).expect("backfill");
    let backfill_ms = ms(started.elapsed());

    let meta = chapters::ensure(&library, &book_id).expect("chapters");
    assert_eq!(meta.len(), PDF_PAGES);
    assert!(meta.iter().all(|chapter| chapter.chars > 0), "正文必须补齐");

    println!("import (page index only):  {import_ms:.1} ms");
    println!("toc (first open, owes text): {toc_ms:.1} ms");
    println!("backfill (text, deferred): {backfill_ms:.1} ms");
    Ok(())
}
