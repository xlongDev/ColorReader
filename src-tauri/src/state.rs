//! Process wide state injected into every command handler.

use std::time::Instant;

use crate::db::{Layout, Library};

/// Values resolved once during setup and shared with commands.
pub struct AppState {
    /// Process start time, used to report uptime without a second clock.
    pub started_at: Instant,
    /// Per-user data directory layout: database, books and covers live here.
    pub layout: Layout,
    /// The open library database. Cheap to clone, so commands can hand one to
    /// a blocking task.
    pub library: Library,
}
