//! ColorReader application entry point.

mod ai;
mod commands;
mod db;
mod dictionary;
mod document;
mod error;
mod library;
mod resource;
mod state;
mod tts;

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
    let builder = tauri::Builder::default();
    // Registered first, and that is not decoration: this plugin decides inside
    // its own setup whether this process is the one that lives. Windows and
    // Linux deliver a `colorreader://` link by starting the app *again* with
    // the URL as its only argument, so the second launch must hand its argv to
    // the instance already running and quit. The `deep-link` feature is what
    // makes that handoff speak the plugin's own event, so `AppShell` follows a
    // forwarded link and a native one through the same path. macOS never gets
    // here on a link — it delivers the URL to the running app as an event
    // instead of forking a process.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // Worth a line at debug level: on the platforms this runs on, "the
        // link did nothing" is otherwise indistinguishable from "the second
        // launch never reached us", and `RUST_LOG=colorreader=debug` is how
        // that gets separated on a real machine.
        tracing::debug!(?argv, "another launch handed its arguments over");
        // The link itself was dealt with above us. What is left is surfacing
        // the window: the reader clicked the link in a browser that is now in
        // front of us, and a reader that has to hunt for the window will not
        // believe the link worked.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Answers `colorreader://book/<id>?annotation=<id>` — the links the
        // notes export writes. macOS delivers them through `RunEvent::Opened`,
        // which the plugin turns into a `deep-link://new-url` event; the shell
        // is already running by then (or was launched for it) and follows it
        // from `AppShell`. On Windows and Linux the plugin reads them off its
        // own argv at startup, and the single-instance plugin above feeds it
        // the argv of every later launch.
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            commands::system::system_info,
            commands::book::book_list,
            commands::book::book_get,
            commands::book::book_asset,
            commands::book::book_source_file,
            commands::book::book_source_url,
            commands::book::book_cover_save,
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
            commands::annotation::annotation_update,
            commands::annotation::annotation_anchor,
            commands::annotation::annotation_note,
            commands::annotation::annotation_list,
            commands::annotation::annotation_delete,
            commands::clippings::clippings_import,
            commands::export::notes_export,
            commands::bookmark::bookmark_create,
            commands::bookmark::bookmark_list,
            commands::bookmark::bookmark_delete,
            commands::search::search_query,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_test,
            commands::ai::ai_chat,
            commands::ai::ai_digest,
            commands::lookup::lookup_translate,
            commands::lookup::lookup_wikipedia,
            commands::dictionary::lookup_dictionary,
            commands::dictionary::dictionary_list,
            commands::dictionary::dictionary_import,
            commands::dictionary::dictionary_delete,
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
            commands::stats::stats_record_session,
            commands::stats::stats_reading,
            commands::sync::sync_get_config,
            commands::sync::sync_set_config,
            commands::sync::sync_test,
            commands::sync::sync_now,
            commands::tag::tag_list,
            commands::tag::tag_delete,
            commands::tag::book_set_tags,
            commands::tts::tts_edge_voices,
            commands::tts::tts_edge_speak,
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
