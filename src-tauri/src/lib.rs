//! ColorReader application entry point.

mod ai;
mod commands;
mod db;
mod document;
mod error;
mod library;
mod resource;
mod state;

use std::fs;
use std::time::Instant;

use tauri::Manager;

use crate::error::AppError;
use crate::state::AppState;

/// Boot the desktop shell.
///
/// Logging goes through `tracing`; set `RUST_LOG=colorreader=debug` to raise the level.
/// Production builds default to `info`.
pub fn run() -> tauri::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("colorreader=info")),
        )
        .init();

    // The cover protocol is captured by the builder, but the library only opens
    // once setup has resolved the data directory; the registry bridges the two.
    let registry = resource::Registry::default();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::system::system_info,
            commands::book::book_list,
            commands::book::book_get,
            commands::book::book_asset,
            commands::book::book_images,
            commands::book::book_stats,
            commands::book::book_import,
            commands::book::book_delete,
            commands::book::book_set_favorite,
            commands::book::pack_export,
            commands::reader::reader_toc,
            commands::reader::reader_chapter,
            commands::reader::reader_set_progress,
            commands::annotation::annotation_create,
            commands::annotation::annotation_list,
            commands::annotation::annotation_delete,
            commands::bookmark::bookmark_create,
            commands::bookmark::bookmark_list,
            commands::bookmark::bookmark_delete,
            commands::search::search_query,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_test,
            commands::ai::ai_chat,
            commands::rag::rag_status,
            commands::rag::rag_index_book,
            commands::rag::rag_chat,
            commands::graph::graph_status,
            commands::graph::graph_build,
            commands::graph::graph_query,
            commands::source::source_list,
            commands::source::source_save,
            commands::source::source_delete,
            commands::source::source_search,
            commands::source::source_book,
            commands::source::source_chapters,
            commands::source::source_download,
            commands::sync::sync_get_config,
            commands::sync::sync_set_config,
            commands::sync::sync_test,
            commands::sync::sync_now,
        ])
        .setup({
            let registry = registry.clone();
            move |app| {
                let data_dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|err| AppError::Message(format!("resolve app data dir: {err}")))?;
                fs::create_dir_all(&data_dir)?;

                let layout = db::Layout::create(data_dir)?;
                let library = db::Library::open(&layout.data_dir)?;
                registry.set(library.clone());

                tracing::info!(path = %layout.data_dir.display(), "application data directory ready");
                app.manage(AppState { started_at: Instant::now(), layout, library });
                Ok(())
            }
        });

    let app = resource::install(builder, registry).build(tauri::generate_context!())?;

    // `App::run` consumes `self` and blocks until the last window closes; it does
    // not return a `Result` in Tauri 2.x, so the only failure path is during build.
    app.run(|_handle, _event| {});
    Ok(())
}
