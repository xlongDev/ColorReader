//! Turning a record's bytes into text, or recognising the image kind it holds.

use super::ENCODING_UTF8;

/// Recognises the image containers MOBI embeds as records.
pub(super) fn sniff_image(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG") {
        Some("png".to_string())
    } else if bytes.starts_with(b"GIF8") {
        Some("gif".to_string())
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpeg".to_string())
    } else {
        None
    }
}

/// Decodes the text with the encoding the MOBI header declares.
///
/// 65001 is UTF-8; everything else is treated as CP-1252, which is what
/// MobiPocket wrote and differs from Latin-1 only in the 0x80–0x9F range.
pub(super) fn decode_text(bytes: &[u8], encoding: u32) -> String {
    if encoding == ENCODING_UTF8 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    bytes.iter().map(|byte| cp1252(*byte)).collect()
}

/// Maps a byte to its CP-1252 character; the high block is the only range that
/// differs from Latin-1.
fn cp1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}',
        '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9f => HIGH[(byte - 0x80) as usize],
        _ => char::from(byte),
    }
}
