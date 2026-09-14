//! IPC command handlers, grouped by domain: `system.*`, `book.*`, `reader.*`,
//! `annotation.*`, `search.*`, `pack.*`, `notes.*`, `ai.*`, `rag.*`, `graph.*`,
//! `source.*`, `sync.*`, `tts.*`, `tag.*`, `clippings.*`, `dictionary.*`.

pub mod ai;
pub mod annotation;
pub mod book;
pub mod bookmark;
pub mod clippings;
pub mod dictionary;
pub mod export;
pub mod font;
pub mod graph;
pub mod lookup;
pub mod rag;
pub mod reader;
pub mod search;
pub mod source;
pub mod stats;
pub mod sync;
pub mod system;
pub mod tag;
pub mod tts;
