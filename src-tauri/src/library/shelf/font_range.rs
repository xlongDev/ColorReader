//! Taking named members out of a remote archive without downloading the archive.
//!
//! HarmonyOS Sans ships as a 49.8 MB zip holding 96 faces. The catalogue wants
//! one of them, and inside the archive that face is 5.6 MB compressed — so
//! fetching the whole thing spends 46 MB of somebody's connection on 95 faces
//! nobody asked for. This module is how that is avoided: read the archive's
//! *own* table of contents over a range request, then ask for exactly the
//! members that are wanted and stitch them into a small archive that the
//! ordinary extractor opens unchanged.
//!
//! 🔴 No byte offset is ever pinned. This is the whole reason the route is safe
//! to take: a zip's central directory is at the *end* of the file, so every
//! offset is read from the archive itself on each install. A catalogue that
//! froze offsets would go quietly stale the first time Huawei repacked the zip;
//! this one cannot, because it still pins only the member's *name* and the
//! sha256 of the bytes it must produce.
//!
//! Nothing here is async, and nothing here touches the network — it is all pure
//! byte work, so every test below runs against a locally built archive with no
//! fixture and no mocking. The caller owns the requests.
//!
//! 🔴 Everything here is also *best-effort by design*: every failure is an
//! ordinary error, and the caller answers all of them the same way, by falling
//! back to downloading the whole archive. That is what lets this module refuse
//! anything it does not fully understand (Zip64, a directory that runs off the
//! end, an entry that lies about its size) instead of guessing — the worst case
//! is a slower install, never a broken one.

use crate::error::{AppError, AppResult};

/// How much of the archive's tail to ask for.
///
/// The end-of-central-directory record is the last thing in the file, but a zip
/// may carry a comment of up to 64 KiB in front of it — so a window this size
/// always contains the record. It is a rounding error next to the members it
/// saves.
pub const TAIL: u64 = 64 * 1024;

/// How many bytes of a member's local header to ask for.
///
/// Thirty is the header's fixed size, and the two lengths this module needs out
/// of it sit at 26 and 28. The name and extra fields that follow are not read
/// here; their *lengths* are all that is wanted, and the member's own chunk is
/// fetched whole afterwards anyway.
pub const HEADER: u64 = 30;

/// The largest central directory this module will read.
///
/// The entry count comes from the archive, so it cannot be trusted, and a
/// declared directory size is what decides how much the caller fetches. Huawei's
/// 146 entries occupy 18 KB; a directory of a hundred thousand is under 6 MB.
/// Past this, the archive is not one of the shapes this route is for.
pub const DIRECTORY_CAP: u64 = 8 * 1024 * 1024;

const EOCD_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const DIRECTORY_SIGNATURE: [u8; 4] = *b"PK\x01\x02";
const LOCAL_SIGNATURE: [u8; 4] = *b"PK\x03\x04";

const EOCD_LEN: usize = 22;
const DIRECTORY_LEN: usize = 46;

/// Field offsets inside the records above, each relative to its own record.
const EOCD_HERE: usize = 8;
const EOCD_TOTAL: usize = 10;
const EOCD_DIRECTORY_SIZE: usize = 12;
const EOCD_DIRECTORY_OFFSET: usize = 16;

const ENTRY_COMPRESSED: usize = 20;
const ENTRY_UNCOMPRESSED: usize = 24;
const ENTRY_NAME_LEN: usize = 28;
const ENTRY_EXTRA_LEN: usize = 30;
const ENTRY_COMMENT_LEN: usize = 32;
const ENTRY_HEADER_OFFSET: usize = 42;

const LOCAL_NAME_LEN: usize = 26;
const LOCAL_EXTRA_LEN: usize = 28;

/// Where the archive's central directory lives, as the archive's own tail
/// describes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub entries: u64,
    pub directory_offset: u64,
    pub directory_size: u64,
}

/// One member of the archive: where its bytes are, and the directory record that
/// describes them.
#[derive(Debug, Clone)]
pub struct Slice {
    pub name: String,
    /// The member's central directory record, verbatim.
    ///
    /// Kept rather than rebuilt. Stitching copies this back with a single field
    /// changed, so nothing about the entry — its flags, its extra field, its
    /// timestamps — has to be understood here in order to survive the trip.
    record: Vec<u8>,
    /// Where the member's local header sits in the archive.
    pub header: u64,
    /// The member's size *as stored in the archive*. This is how many bytes the
    /// caller must fetch after the header, and the only size that bounds the
    /// download.
    pub compressed: u64,
    /// The size the archive claims the member inflates to. Not trusted — it is
    /// carried so the caller can cap it before anything is allocated.
    pub uncompressed: u64,
}

impl Slice {
    /// How many bytes from `header` hold this member whole.
    ///
    /// The name and extra lengths are passed in rather than read from the
    /// central directory record: the format allows a member's local header to
    /// declare different ones, and it is the local header's that decide where
    /// the data starts.
    pub fn chunk_len(&self, name_len: u64, extra_len: u64) -> u64 {
        HEADER + name_len + extra_len + self.compressed
    }
}

/// Reads the archive's end-of-central-directory record out of its last bytes.
///
/// Searches backwards because the signature is not escaped, so a comment
/// containing those four bytes would otherwise be mistaken for the record.
pub fn layout(tail: &[u8]) -> AppResult<Layout> {
    let at = tail
        .windows(EOCD_SIGNATURE.len())
        .rposition(|window| window == EOCD_SIGNATURE)
        .ok_or_else(|| unreadable("尾部没有中央目录记录"))?;

    let entries = u64::from(u16_at(tail, at + EOCD_TOTAL).ok_or_else(truncated)?);
    let directory_size = u64::from(u32_at(tail, at + EOCD_DIRECTORY_SIZE).ok_or_else(truncated)?);
    let directory_offset =
        u64::from(u32_at(tail, at + EOCD_DIRECTORY_OFFSET).ok_or_else(truncated)?);

    // Zip64 parks each of these fields at its unsigned maximum and puts the real
    // value in an extra record this module does not read. Reading a sentinel as
    // a size would fetch the wrong bytes, so say so plainly and let the caller
    // take the route that handles it.
    if entries == u64::from(u16::MAX)
        || directory_size == u64::from(u32::MAX)
        || directory_offset == u64::from(u32::MAX)
    {
        return Err(unreadable("档案是 Zip64"));
    }
    if directory_size > DIRECTORY_CAP {
        return Err(unreadable("中央目录大得不合理"));
    }
    Ok(Layout { entries, directory_offset, directory_size })
}

/// The members named in `wanted`, in the order they were asked for.
///
/// A name the archive does not have is simply absent from the result rather
/// than an error: one of the callers' members is the vendor's licence file,
/// which is optional, and only the caller knows which absence is fatal.
pub fn slices(directory: &[u8], layout: &Layout, wanted: &[&str]) -> AppResult<Vec<Slice>> {
    let mut found: Vec<Option<Slice>> = vec![None; wanted.len()];
    let mut at = 0usize;

    for _ in 0..layout.entries {
        let record = directory.get(at..at + DIRECTORY_LEN).ok_or_else(truncated)?;
        if record[..4] != DIRECTORY_SIGNATURE {
            return Err(unreadable("中央目录条目的签名不对"));
        }
        let name_len = usize::from(u16_at(record, ENTRY_NAME_LEN).ok_or_else(truncated)?);
        let extra_len = usize::from(u16_at(record, ENTRY_EXTRA_LEN).ok_or_else(truncated)?);
        let comment_len = usize::from(u16_at(record, ENTRY_COMMENT_LEN).ok_or_else(truncated)?);

        let whole_len = DIRECTORY_LEN + name_len + extra_len + comment_len;
        let whole = directory.get(at..at + whole_len).ok_or_else(truncated)?;
        at += whole_len;

        let name = std::str::from_utf8(&whole[DIRECTORY_LEN..DIRECTORY_LEN + name_len])
            .map_err(|_| unreadable("成员名不是 UTF-8"))?;
        let Some(index) = wanted.iter().position(|want| *want == name) else {
            continue;
        };
        // The first record wins, so a later duplicate cannot displace the one
        // the hash was pinned against.
        if found[index].is_some() {
            continue;
        }

        let compressed = u64::from(u32_at(whole, ENTRY_COMPRESSED).ok_or_else(truncated)?);
        let uncompressed = u64::from(u32_at(whole, ENTRY_UNCOMPRESSED).ok_or_else(truncated)?);
        let header = u64::from(u32_at(whole, ENTRY_HEADER_OFFSET).ok_or_else(truncated)?);
        if [compressed, uncompressed, header].contains(&u64::from(u32::MAX)) {
            return Err(unreadable("成员是 Zip64"));
        }

        found[index] = Some(Slice {
            name: name.to_string(),
            record: whole.to_vec(),
            header,
            compressed,
            uncompressed,
        });
    }

    Ok(found.into_iter().flatten().collect())
}

/// A member's local header, as far as its name and extra lengths.
///
/// Read rather than assumed equal to the central directory's: the format allows
/// them to differ, and where the member's data starts is computed from these.
pub fn local_lengths(header: &[u8]) -> AppResult<(u64, u64)> {
    if header.get(..4) != Some(LOCAL_SIGNATURE.as_slice()) {
        return Err(unreadable("成员头部的签名不对"));
    }
    let name_len = u64::from(u16_at(header, LOCAL_NAME_LEN).ok_or_else(truncated)?);
    let extra_len = u64::from(u16_at(header, LOCAL_EXTRA_LEN).ok_or_else(truncated)?);
    Ok((name_len, extra_len))
}

/// A zip holding only `parts`, built out of the archive's own bytes.
///
/// The chunks are copied in whole — local header, name, extra field and data —
/// so the member arrives in the new archive exactly as it left the old one, data
/// descriptor and all. Only two things are written fresh: each record's
/// local-header offset, which points into the new file, and the trailing record
/// that says where the new directory is.
pub fn stitch(parts: &[(Slice, Vec<u8>)]) -> AppResult<Vec<u8>> {
    if parts.is_empty() {
        return Err(unreadable("没有要拼进新档案的成员"));
    }

    let mut body: Vec<u8> = Vec::new();
    let mut directory: Vec<u8> = Vec::new();
    for (slice, chunk) in parts {
        let at = u32::try_from(body.len()).map_err(|_| unreadable("拼出来的档案太大"))?;
        body.extend_from_slice(chunk);

        let mut record = slice.record.clone();
        let field = ENTRY_HEADER_OFFSET..ENTRY_HEADER_OFFSET + 4;
        record[field].copy_from_slice(&at.to_le_bytes());
        directory.extend_from_slice(&record);
    }

    let entries = u16::try_from(parts.len()).map_err(|_| unreadable("成员太多"))?;
    let directory_offset = u32::try_from(body.len()).map_err(|_| unreadable("拼出来的档案太大"))?;
    let directory_size = u32::try_from(directory.len()).map_err(|_| unreadable("中央目录太大"))?;

    let mut stitched = body;
    stitched.extend_from_slice(&directory);
    stitched.extend_from_slice(&eocd(entries, directory_size, directory_offset));
    Ok(stitched)
}

/// A bare end-of-central-directory record: one disk, no comment.
fn eocd(entries: u16, directory_size: u32, directory_offset: u32) -> [u8; EOCD_LEN] {
    let mut record = [0u8; EOCD_LEN];
    record[..4].copy_from_slice(&EOCD_SIGNATURE);
    record[EOCD_HERE..EOCD_HERE + 2].copy_from_slice(&entries.to_le_bytes());
    record[EOCD_TOTAL..EOCD_TOTAL + 2].copy_from_slice(&entries.to_le_bytes());
    record[EOCD_DIRECTORY_SIZE..EOCD_DIRECTORY_SIZE + 4]
        .copy_from_slice(&directory_size.to_le_bytes());
    record[EOCD_DIRECTORY_OFFSET..EOCD_DIRECTORY_OFFSET + 4]
        .copy_from_slice(&directory_offset.to_le_bytes());
    record
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Not a message for the reader: the caller logs it and takes the other route,
/// so it exists to say *why* the narrow route was not usable.
fn unreadable(what: &str) -> AppError {
    AppError::Message(format!("按 Range 取成员不可用：{what}"))
}

fn truncated() -> AppError {
    unreadable("记录被截断")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read, Write};

    const FACE: &str = "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Regular.ttf";
    const BOLD: &str = "HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_Bold.ttf";
    const TERMS: &str = "HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt";

    fn archive_bytes(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in members {
            writer
                .start_file(name.to_string(), zip::write::SimpleFileOptions::default())
                .expect("start member");
            writer.write_all(bytes).expect("write member");
        }
        writer.finish().expect("finish archive").into_inner()
    }

    /// Three members, only two of them wanted: a stitch that quietly kept
    /// everything would show up as a bigger file and an extra name, not as a
    /// passing test.
    fn fixture() -> Vec<u8> {
        archive_bytes(&[
            (FACE, b"\x00\x01\x00\x00 the regular face"),
            (BOLD, b"\x00\x01\x00\x00 the bold face"),
            (TERMS, b"Copyright 2021 Huawei Device Co., Ltd."),
        ])
    }

    fn open(archive: &[u8]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        zip::ZipArchive::new(Cursor::new(archive.to_vec())).expect("open archive")
    }

    fn extract(archive: &[u8], name: &str) -> Vec<u8> {
        let mut zip = open(archive);
        let mut bytes = Vec::new();
        zip.by_name(name).expect("member").read_to_end(&mut bytes).expect("read member");
        bytes
    }

    /// The archive's last `TAIL` bytes — or all of it, since every fixture here
    /// is far smaller than the window the real archive needs.
    fn tail_of(archive: &[u8]) -> &[u8] {
        &archive[archive.len().saturating_sub(TAIL as usize)..]
    }

    /// A fixture's tail, as a vector, with the field at `field` overwritten.
    /// Both tests below are about a record that lies, so the lie has to be
    /// written into the bytes rather than into a struct.
    fn tail_with(archive: &[u8], field: usize, value: [u8; 4]) -> Vec<u8> {
        let mut tail = tail_of(archive).to_vec();
        let at = tail.windows(4).rposition(|window| window == EOCD_SIGNATURE).expect("record");
        tail[at + field..at + field + 4].copy_from_slice(&value);
        tail
    }

    fn directory_of(archive: &[u8]) -> (Layout, Vec<u8>) {
        let layout = layout(tail_of(archive)).expect("layout");
        let at = layout.directory_offset as usize;
        (layout, archive[at..at + layout.directory_size as usize].to_vec())
    }

    /// The narrow route with the network taken out: the same steps the caller
    /// runs, against bytes it already has.
    fn narrow(archive: &[u8], wanted: &[&str]) -> Vec<u8> {
        let (layout, directory) = directory_of(archive);
        let parts = slices(&directory, &layout, wanted)
            .expect("slices")
            .into_iter()
            .map(|slice| {
                let at = slice.header as usize;
                let (name_len, extra_len) = local_lengths(&archive[at..]).expect("local header");
                let len = slice.chunk_len(name_len, extra_len) as usize;
                (slice, archive[at..at + len].to_vec())
            })
            .collect::<Vec<_>>();
        stitch(&parts).expect("stitch")
    }

    #[test]
    fn the_layout_comes_out_of_the_archives_own_tail() {
        let archive = fixture();
        let (layout, directory) = directory_of(&archive);
        assert_eq!(layout.entries, 3);
        assert_eq!(directory.len() as u64, layout.directory_size);
        // No comment, so the directory ends exactly where the record begins.
        assert_eq!(layout.directory_offset + layout.directory_size, archive.len() as u64 - 22);
    }

    #[test]
    fn a_tail_without_an_end_record_is_refused() {
        assert!(layout(b"not a zip at all, not even close").is_err());
        assert!(layout(b"").is_err());
    }

    #[test]
    fn zip64_is_refused_rather_than_read_as_a_size() {
        let tail = tail_with(&fixture(), EOCD_DIRECTORY_OFFSET, u32::MAX.to_le_bytes());
        assert!(layout(&tail).is_err(), "Zip64 的哨兵值不能被当成真的偏移");
    }

    #[test]
    fn a_directory_larger_than_the_cap_is_refused() {
        let over = u32::try_from(DIRECTORY_CAP + 1).expect("fits");
        let tail = tail_with(&fixture(), EOCD_DIRECTORY_SIZE, over.to_le_bytes());
        assert!(layout(&tail).is_err());
    }

    #[test]
    fn the_slices_are_the_members_asked_for_in_the_order_asked_for() {
        let archive = fixture();
        let (layout, directory) = directory_of(&archive);
        let names: Vec<String> = slices(&directory, &layout, &[TERMS, FACE])
            .expect("slices")
            .into_iter()
            .map(|slice| slice.name)
            .collect();
        assert_eq!(names, vec![TERMS.to_string(), FACE.to_string()]);
    }

    #[test]
    fn a_member_the_archive_does_not_have_is_simply_absent() {
        let archive = fixture();
        let (layout, directory) = directory_of(&archive);
        let names: Vec<String> = slices(&directory, &layout, &[FACE, "nope.ttf"])
            .expect("slices")
            .into_iter()
            .map(|slice| slice.name)
            .collect();
        assert_eq!(names, vec![FACE.to_string()]);
    }

    #[test]
    fn a_directory_that_declares_more_entries_than_it_holds_is_refused() {
        let archive = fixture();
        let (mut layout, directory) = directory_of(&archive);
        layout.entries = 99;
        assert!(slices(&directory, &layout, &[FACE]).is_err());
    }

    #[test]
    fn a_local_header_says_where_its_data_starts() {
        let archive = fixture();
        let (name_len, extra_len) = local_lengths(&archive).expect("local header");
        assert_eq!(name_len, FACE.len() as u64);
        assert!(extra_len <= 4096, "额外字段不该有这么长：{extra_len}");
    }

    #[test]
    fn something_that_is_not_a_local_header_is_refused() {
        assert!(local_lengths(b"PK\x01\x02 not a local header at all").is_err());
        assert!(local_lengths(b"short").is_err());
    }

    #[test]
    fn stitching_nothing_is_refused() {
        assert!(stitch(&[]).is_err());
    }

    #[test]
    fn the_stitched_archive_holds_the_members_and_nothing_else() {
        let archive = fixture();
        let small = narrow(&archive, &[FACE, TERMS]);
        assert!(small.len() < archive.len(), "拼出来的档案必须比整包小");

        let mut zip = open(&small);
        let mut names: Vec<String> = (0..zip.len())
            .map(|index| zip.by_index(index).expect("entry").name().expect("name").to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec![FACE.to_string(), TERMS.to_string()]);
    }

    /// The equivalence the whole route rests on: what comes out of the small
    /// archive is what would have come out of the big one.
    #[test]
    fn a_stitched_member_is_byte_for_byte_the_one_in_the_whole_archive() {
        let archive = fixture();
        let small = narrow(&archive, &[FACE, TERMS]);
        assert_eq!(extract(&small, FACE), extract(&archive, FACE));
        assert_eq!(extract(&small, TERMS), extract(&archive, TERMS));
    }

    /// The shape the vendor's archive actually has: the data-descriptor flag is
    /// set and the local header's crc and sizes are zero, so those values exist
    /// only in the central directory. `zip` writes them inline, so the shape has
    /// to be made by hand — and it is worth making, because a stitched member
    /// carries its local header over untouched and would otherwise only ever be
    /// read in the easier shape.
    #[test]
    fn a_member_whose_local_header_defers_its_sizes_still_reads() {
        let mut archive = archive_bytes(&[(FACE, b"\x00\x01\x00\x00 the regular face")]);
        archive[6..8].copy_from_slice(&0x0008u16.to_le_bytes());
        archive[14..26].fill(0);

        let small = narrow(&archive, &[FACE]);
        assert_eq!(extract(&small, FACE), b"\x00\x01\x00\x00 the regular face");
    }
}
