//! PalmDOC (LZ77) and HUFF/CDIC, the two compressions Amazon ships.

use crate::error::{AppError, AppResult};

use super::bytes::{be_u16, be_u32, slice8};

/// Bytes of trailing data appended to each text record, per the extra flags.
///
/// The entries are stored back to front, each sized by a backward-encoded
/// variable-width integer: entry 16 sits at the very end, entry 1 right after
/// the text. Bit 1 is special and carries multibyte-overlap bytes instead.
///
/// ponytail: derived from the format documentation rather than a sample file,
/// so the result is clamped — a misread can never eat a whole record.
pub(super) fn trailing_len(record: &[u8], extra_flags: u16) -> usize {
    let mut total = 0usize;
    let mut flags = extra_flags >> 1;
    while flags != 0 {
        if flags & 1 != 0 {
            total += trailing_entry_len(record, record.len().saturating_sub(total));
        }
        flags >>= 1;
    }
    if extra_flags & 1 != 0
        && let Some(last) = record.get(record.len().saturating_sub(total + 1))
    {
        total += usize::from(last & 0x3) + 1;
    }
    total.min(record.len())
}

/// Size of one trailing entry, read as a backward variable-width integer.
fn trailing_entry_len(record: &[u8], mut size: usize) -> usize {
    let mut value = 0u32;
    let mut shift = 0u32;
    loop {
        if size == 0 {
            return value as usize;
        }
        let byte = record[size - 1];
        value |= u32::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 != 0 || shift >= 28 {
            return value as usize;
        }
        size -= 1;
    }
}

/// Expands PalmDOC (LZ77) compressed text.
pub(super) fn palmdoc_decompress(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 2);
    let mut index = 0usize;
    while index < data.len() {
        let byte = data[index];
        index += 1;
        match byte {
            // A zero byte means the next byte is a literal.
            0 => {
                if let Some(&next) = data.get(index) {
                    out.push(next);
                }
                index += 1;
            }
            // 1..=8: copy that many following bytes verbatim.
            1..=8 => {
                for _ in 0..byte {
                    match data.get(index) {
                        Some(&next) => {
                            out.push(next);
                            index += 1;
                        }
                        None => break,
                    }
                }
            }
            // 0x09..=0x7f: the byte is itself.
            0x09..=0x7f => out.push(byte),
            // 0x80..=0xbf: a length-distance pair, 11 bits of distance.
            0x80..=0xbf => {
                let Some(&next) = data.get(index) else { break };
                index += 1;
                let pair = (u16::from(byte) << 8) | u16::from(next);
                let distance = ((pair >> 3) & 0x7ff) as usize;
                let length = (pair & 7) as usize + 3;
                if distance == 0 || distance > out.len() {
                    break;
                }
                let from = out.len() - distance;
                for offset in 0..length {
                    let copied = out[from + offset];
                    out.push(copied);
                }
            }
            // 0xc0..=0xff: a space followed by (byte ^ 0x80).
            _ => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
    }
    out
}

/// A phrase in the HUFF/CDIC dictionary: literal, or another bitstream.
#[derive(Clone)]
enum Phrase {
    Literal(Vec<u8>),
    Compressed(Vec<u8>),
    Expanded(Vec<u8>),
}

/// HUFF/CDIC decompressor, the compression Amazon actually ships.
///
/// One HUFF record holds the code tables, the following CDIC records hold the
/// phrase dictionary the codes index into.
pub(super) struct HuffCdic {
    /// Per leading byte: code length, terminal flag, pre-shifted max code.
    table: Vec<(u8, bool, u32)>,
    mincode: Vec<u32>,
    maxcode: Vec<u32>,
    phrases: Vec<Phrase>,
}

impl HuffCdic {
    pub(super) fn new(
        records: &[Vec<u8>],
        start: usize,
        huffman_index: usize,
        huffman_count: usize,
    ) -> AppResult<Self> {
        let huff = records
            .get(start + huffman_index)
            .ok_or_else(|| AppError::Parse("MOBI 缺少 HUFF 记录".into()))?;
        if huff.len() < 24 || &huff[0..8] != b"HUFF\x00\x00\x00\x18" {
            return Err(AppError::Parse("HUFF 记录头部无效".into()));
        }
        let table_at = be_u32(huff, 8) as usize;
        let bounds_at = be_u32(huff, 12) as usize;
        if huff.len() < table_at + 1024 || huff.len() < bounds_at + 256 {
            return Err(AppError::Parse("HUFF 记录被截断".into()));
        }

        let mut table = Vec::with_capacity(256);
        for index in 0..256 {
            let value = be_u32(huff, table_at + index * 4);
            let length = (value & 0x1f) as u8;
            let terminal = value & 0x80 != 0;
            // Codes are pre-shifted so the decoder compares a 32-bit window
            // against them without normalising.
            let maxcode = if length > 0 {
                ((value >> 8).wrapping_add(1) << (32 - length)).wrapping_sub(1)
            } else {
                0
            };
            table.push((length, terminal, maxcode));
        }

        let mut mincode = vec![0u32];
        let mut maxcode = vec![0u32];
        for length in 1..=32usize {
            let at = bounds_at + (length - 1) * 8;
            mincode.push(be_u32(huff, at) << (32 - length));
            let upper = be_u32(huff, at + 4);
            maxcode.push((upper.wrapping_add(1) << (32 - length)).wrapping_sub(1));
        }

        let mut phrases: Vec<Phrase> = Vec::new();
        for offset in 1..huffman_count {
            let Some(cdic) = records.get(start + huffman_index + offset) else { break };
            if cdic.len() < 16 || &cdic[0..8] != b"CDIC\x00\x00\x00\x10" {
                continue;
            }
            let count = be_u32(cdic, 8) as usize;
            let bits = be_u32(cdic, 12) as usize;
            let entries = (1usize << bits.min(20)).min(count.saturating_sub(phrases.len()));
            if cdic.len() < 16 + entries * 2 {
                break;
            }
            for index in 0..entries {
                let at = 16 + be_u16(cdic, 16 + index * 2) as usize;
                if at + 2 > cdic.len() {
                    break;
                }
                let head = be_u16(cdic, at);
                let length = (head & 0x7fff) as usize;
                let slice = cdic[at + 2..(at + 2 + length).min(cdic.len())].to_vec();
                // High bit set: a literal phrase. Clear: another bitstream.
                phrases.push(if head & 0x8000 != 0 {
                    Phrase::Literal(slice)
                } else {
                    Phrase::Compressed(slice)
                });
            }
        }

        Ok(Self { table, mincode, maxcode, phrases })
    }

    pub(super) fn decompress(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() * 2);
        self.expand(data, &mut out);
        out
    }

    /// Walks the bitstream, appending phrase after phrase to `out`.
    ///
    /// Codes are read most-significant bit first from a 32-bit window carried in
    /// a 64-bit accumulator; a phrase that is itself a bitstream is expanded
    /// through the same decoder and memoised.
    fn expand(&mut self, data: &[u8], out: &mut Vec<u8>) {
        // Eight spare bytes let the window always read a full u64.
        let mut window = data.to_vec();
        window.extend_from_slice(&[0u8; 8]);

        let mut at = 0usize;
        let mut bits = u64::from_be_bytes(slice8(&window, at));
        let mut shift = 32i32;
        let mut remaining = (data.len() * 8) as i64;

        while remaining > 0 {
            if shift <= 0 {
                at += 4;
                bits = u64::from_be_bytes(slice8(&window, at));
                shift += 32;
            }
            let code = (bits >> shift) as u32;
            let (mut length, terminal, mut maxcode) = self.table[(code >> 24) as usize];
            if !terminal {
                while (length as usize) < self.mincode.len() - 1
                    && code < self.mincode[length as usize]
                {
                    length += 1;
                }
                if (length as usize) < self.maxcode.len() {
                    maxcode = self.maxcode[length as usize];
                }
            }
            shift -= i32::from(length);
            remaining -= i64::from(length);
            // A zero-length code would spin forever; stop instead.
            if remaining < 0 || length == 0 {
                break;
            }
            let index = (maxcode.wrapping_sub(code) >> (32 - length)) as usize;
            let nested = match self.phrases.get(index) {
                Some(Phrase::Compressed(bytes)) => Some(bytes.clone()),
                Some(Phrase::Literal(bytes)) | Some(Phrase::Expanded(bytes)) => {
                    out.extend_from_slice(bytes);
                    None
                }
                None => break,
            };
            if let Some(bytes) = nested {
                let mut expanded = Vec::new();
                self.expand(&bytes, &mut expanded);
                out.extend_from_slice(&expanded);
                if let Some(slot) = self.phrases.get_mut(index) {
                    *slot = Phrase::Expanded(expanded);
                }
            }
        }
    }
}
