//! `search.*` commands: full-text lookup across the library or one book.

use tauri::State;

use crate::db::Library;
use crate::error::AppResult;
use crate::library::{chapters, repository, search, search::SearchHit};
use crate::state::AppState;

/// Default and maximum number of hits returned per query.
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

/// `search.query` — chapters whose text contains `needle`, best match first.
///
/// Runs on a blocking task: books imported before the reader engine existed get
/// their chapters extracted on first use, which reads the source file.
#[tauri::command]
pub async fn search_query(
    state: State<'_, AppState>,
    needle: String,
    book_id: Option<String>,
    limit: Option<usize>,
) -> AppResult<Vec<SearchHit>> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        index_missing(&library, book_id.as_deref())?;
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        library.with(|conn| search::query(conn, &needle, book_id.as_deref(), limit))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("检索被中断：{err}")))?
}

/// Extracts chapters for every book that has none, so their text is searchable.
fn index_missing(library: &Library, book_id: Option<&str>) -> AppResult<()> {
    for id in library.with(|conn| repository::books_without_chapters(conn, book_id))? {
        chapters::ensure(library, &id)?;
    }
    Ok(())
}
