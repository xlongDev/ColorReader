//! Big-endian readers, shared by every other module in this directory.

/// Copies eight bytes starting at `at`, zero-padded past the end.
pub(super) fn slice8(data: &[u8], at: usize) -> [u8; 8] {
    let mut bytes = [0u8; 8];
    for (slot, value) in bytes.iter_mut().zip(data.get(at..at + 8).unwrap_or(&[])) {
        *slot = *value;
    }
    bytes
}

pub(super) fn be_u16(data: &[u8], at: usize) -> u16 {
    match data.get(at..at + 2) {
        Some([high, low]) => u16::from_be_bytes([*high, *low]),
        _ => 0,
    }
}

pub(super) fn be_u32(data: &[u8], at: usize) -> u32 {
    match data.get(at..at + 4) {
        Some(bytes) => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        _ => 0,
    }
}
