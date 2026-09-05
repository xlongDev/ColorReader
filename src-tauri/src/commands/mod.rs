//! IPC command handlers, grouped by domain: `system.*`, `book.*`, `reader.*`,
//! `annotation.*`, `search.*`, `pack.*`, `ai.*`, `rag.*`, `graph.*`, `source.*`,
//! `sync.*`.

pub mod ai;
pub mod annotation;
pub mod book;
pub mod bookmark;
pub mod graph;
pub mod rag;
pub mod reader;
pub mod search;
pub mod source;
pub mod sync;
pub mod system;
