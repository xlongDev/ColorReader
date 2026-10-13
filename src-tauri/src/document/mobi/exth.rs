//! The EXTH block: the record types we read, and how their values are stored.

use std::collections::HashMap;

use super::bytes::be_u32;

/// EXTH record types we read.
pub(super) const EXTH_AUTHOR: u32 = 100;
pub(super) const EXTH_PUBLISHER: u32 = 101;
pub(super) const EXTH_DESCRIPTION: u32 = 103;
pub(super) const EXTH_ISBN: u32 = 104;
pub(super) const EXTH_ASIN: u32 = 113;
pub(super) const EXTH_KF8_BOUNDARY: u32 = 121;
pub(super) const EXTH_COVER: u32 = 201;
pub(super) const EXTH_THUMB: u32 = 202;
pub(super) const EXTH_TITLE: u32 = 503;
pub(super) const EXTH_LANGUAGE: u32 = 524;

/// Reads the block's records. A malformed length ends the walk rather than
/// failing the book: whatever was read up to that point is still usable.
pub(super) fn parse(header: &[u8], at: usize) -> HashMap<u32, Vec<u8>> {
    let mut out: HashMap<u32, Vec<u8>> = HashMap::new();
    let count = be_u32(header, at + 8) as usize;
    let mut cursor = at + 12;
    for _ in 0..count {
        if cursor + 8 > header.len() {
            break;
        }
        let kind = be_u32(header, cursor);
        let length = be_u32(header, cursor + 4) as usize;
        if length < 8 || cursor + length > header.len() {
            break;
        }
        let data = header[cursor + 8..cursor + length].to_vec();
        out.entry(kind).or_insert(data);
        cursor += length;
    }
    out
}

/// A text record's value, trimmed; empty counts as absent.
pub(super) fn text(exth: &HashMap<u32, Vec<u8>>, kind: u32) -> Option<String> {
    let data = exth.get(&kind)?;
    let text = String::from_utf8_lossy(data).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// A numeric record's value. Some producers store it as a shorter big-endian
/// integer, so one to three bytes are accepted as well.
pub(super) fn number(exth: &HashMap<u32, Vec<u8>>, kind: u32) -> Option<u32> {
    let data = exth.get(&kind)?;
    match data.len() {
        4 => Some(be_u32(data, 0)),
        1..=3 => Some(data.iter().fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte))),
        _ => None,
    }
}
