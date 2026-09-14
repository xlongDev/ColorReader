//! The platform's own dictionary: macOS `DictionaryServices`.
//!
//! The 词典 action needs a layer that works with no key and no network. Instead
//! of shipping — or making the reader download — a dictionary dataset, this asks
//! the platform: macOS has one built in, the same source the system "Look Up"
//! panel uses. On a Chinese system an English word comes back as Chinese senses
//! with pinyin, and a Chinese headword as its English gloss, with no data in this
//! repository at all. Lookups are local and instantaneous.
//!
//! Two things were measured against the live service rather than assumed, and
//! they shape the code:
//!
//! * The definition is **plain text** (headword, IPA, senses, `▸` example
//!   markers). There is no markup to strip, so an entry is passed through
//!   verbatim and rendered as it comes.
//! * A **passage is not a lookup**. `hello world`, a full sentence and a long
//!   Chinese clause all come back empty, while `space` inside `"  spaced  "`
//!   does resolve. A sentence selection therefore falls through to the AI path
//!   by itself, and no heuristic is needed to route it there.
//!
//! No other platform ships an equivalent, so `Lookup::Unavailable` says so
//! rather than pretending the term is unknown. The layer below this one — the
//! dictionaries the reader imports — is [`crate::library::dictionaries`], and
//! `lookup_dictionary` walks platform first, imported second.

use serde::Serialize;

/// What a lookup turned up.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Lookup {
    /// Something knew the term. `text` is the entry verbatim; `source` names the
    /// dictionary it came from, and is `None` for the platform's own — the popup
    /// only labels an answer when it has to say which one won.
    Found { text: String, source: Option<String> },
    /// The dictionary is there but does not carry this term. An ordinary answer,
    /// not a failure — the caller falls through to the AI explanation.
    ///
    /// `allow` outside macOS, the mirror of `Unavailable` above: with no system
    /// dictionary there is nothing to be *missing* from, so only the macOS
    /// implementation ever builds this variant. It stays in the enum because the
    /// API — and the popup's fall-through — speaks all three states, and a
    /// non-macOS build used to fail on it under `-D warnings`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Missing,
    /// This platform ships no system dictionary.
    ///
    /// `allow` rather than `expect`: on macOS this variant is genuinely never
    /// built — the platform always has a dictionary — and the test that pins the
    /// three-state contract does construct it, which would leave an `expect`
    /// unfulfilled and fail the gate.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unavailable,
}

/// Looks `term` up in the platform's dictionary.
#[cfg(target_os = "macos")]
pub fn define(term: &str) -> Lookup {
    let term = term.trim();
    if term.is_empty() {
        return Lookup::Missing;
    }
    match platform::define(term) {
        Some(text) => Lookup::Found { text, source: None },
        None => Lookup::Missing,
    }
}

/// Everywhere else the answer is "there is no dictionary here", which is a
/// different statement from "this word is not in it".
#[cfg(not(target_os = "macos"))]
pub fn define(_term: &str) -> Lookup {
    Lookup::Unavailable
}

#[cfg(target_os = "macos")]
mod platform {
    use std::os::raw::c_char;

    use core_foundation_sys::base::{CFRange, CFRelease, CFTypeRef, kCFAllocatorDefault};
    use core_foundation_sys::string::{
        CFStringCreateWithBytes, CFStringGetCString, CFStringGetLength,
        CFStringGetMaximumSizeForEncoding, kCFStringEncodingUTF8,
    };

    // DictionaryServices is a subframework of CoreServices; linking the umbrella
    // resolves `DCSCopyTextDefinition`, which is how the framework is addressed.
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        /// `DCSDictionaryRef` is opaque. `null` means "the dictionaries the user
        /// has enabled", i.e. exactly what Look Up searches.
        fn DCSCopyTextDefinition(
            dictionary: CFTypeRef,
            text: CFTypeRef,
            range: CFRange,
        ) -> CFTypeRef;
    }

    /// The definition of `term`, or `None` when the dictionary has no entry.
    pub(super) fn define(term: &str) -> Option<String> {
        let bytes = term.as_bytes();
        unsafe {
            let cf_term = CFStringCreateWithBytes(
                kCFAllocatorDefault,
                bytes.as_ptr(),
                bytes.len() as isize,
                kCFStringEncodingUTF8,
                false as _,
            );
            if cf_term.is_null() {
                return None;
            }
            // The whole (trimmed) term is the range: the dictionary resolves the
            // headword itself, and a passage simply has no entry.
            let range = CFRange { location: 0, length: CFStringGetLength(cf_term) };
            let definition = DCSCopyTextDefinition(std::ptr::null(), cf_term as CFTypeRef, range);
            let text = if definition.is_null() { None } else { read_string(definition) };
            if !definition.is_null() {
                CFRelease(definition);
            }
            CFRelease(cf_term as CFTypeRef);
            text
        }
    }

    /// Copies a CFString out as UTF-8, trimmed.
    ///
    /// # Safety
    /// `string` must be a live `CFStringRef`.
    unsafe fn read_string(string: CFTypeRef) -> Option<String> {
        unsafe {
            let capacity = CFStringGetMaximumSizeForEncoding(
                CFStringGetLength(string as _),
                kCFStringEncodingUTF8,
            ) + 1;
            if capacity <= 1 {
                return None;
            }
            let mut buffer = vec![0 as c_char; capacity as usize];
            let converted = CFStringGetCString(
                string as _,
                buffer.as_mut_ptr(),
                capacity,
                kCFStringEncodingUTF8,
            );
            if converted == 0 {
                return None;
            }
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
            let bytes: Vec<u8> = buffer[..end].iter().map(|byte| *byte as u8).collect();
            // Trim the trailing separator the entries come with.
            Some(String::from_utf8_lossy(&bytes).trim_end().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_term_is_never_a_lookup() {
        // The rule belongs to the macOS implementation, which never asks the
        // framework about a blank term. Everywhere else there is no
        // implementation to ask, and every term — blank included — is
        // `Unavailable`, which is the honest answer there. Asserting only
        // `Missing` made this test fail on Linux and Windows, where `define`
        // is a stub: a property of one platform written as a universal one.
        let expected =
            if cfg!(target_os = "macos") { Lookup::Missing } else { Lookup::Unavailable };
        assert_eq!(define("   "), expected);
    }

    #[test]
    fn the_three_outcomes_stay_distinguishable() {
        // "Not in the dictionary" and "no dictionary here" are different
        // answers, and only the first one is worth telling the reader about —
        // so the popup must be able to tell them apart. This also keeps
        // `Unavailable` reachable on macOS, where `define` never returns it.
        assert_ne!(Lookup::Unavailable, Lookup::Missing);
        assert_ne!(Lookup::Missing, Lookup::Found { text: String::new(), source: None });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_dictionary_answers_a_real_word() {
        // The one check that proves the FFI still lines up with the framework:
        // a live word must yield a non-empty entry...
        let Lookup::Found { text, source } = define("hello") else {
            panic!("系统词典必须能查到 hello");
        };
        assert!(!text.is_empty(), "词条不能是空的");
        assert!(text.to_lowercase().contains("hell"), "词条要真的是 hello：{text}");
        assert_eq!(source, None, "系统词典不标来源");

        // ...and a non-word must not.
        assert_eq!(define("zzzzqqqq"), Lookup::Missing, "生造词必须是 Missing");
    }
}
