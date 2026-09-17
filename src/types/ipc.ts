/**
 * Rust is the single source of truth for everything that crosses IPC: the
 * shapes come from `lib/bindings.ts`, generated from the command signatures by
 * `cargo test export_bindings`. Do not hand-mirror them again.
 *
 * What still lives here is only what has no Rust counterpart — the snippet
 * markers and the input shapes the UI assembles before calling a command — plus
 * aliases for generated types the UI names differently.
 */

export type * from "@/lib/bindings";

export type {
  ChatMessage as AiMessage,
  Role as AiRole,
  Lookup as DictionaryLookup,
  Dictionary as LocalDictionary,
  Font_Serialize as LocalFont,
  Outcome as ClippingsOutcome,
  Downloaded as SourceDownloaded,
  SourceDef as SourceRules,
  Change as SyncChange,
  Tally as SyncTally,
} from "@/lib/bindings";

/** Characters the backend wraps a match in. Mirrors `library/search.rs`. */
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

/**
 * How a highlight paints its ink.
 *
 * Not in the bindings because Rust stores it as a plain `String` and validates
 * it at the trust boundary (`validated_style`) — the union is a UI narrowing,
 * not a wire shape.
 */
export type AnnotationStyle = "highlight" | "underline" | "squiggly";

/** Input for `annotation.create`, spread into the command's positional args. */
export interface NewAnnotation {
  bookId: string;
  chapterIdx: number;
  startChar: number;
  endChar: number;
  text: string;
  cfi?: string;
  color?: string;
  style?: AnnotationStyle;
}

/** Input for `bookmark.create`, spread into the command's positional args. */
export interface NewBookmark {
  bookId: string;
  chapterIdx: number;
  fraction: number;
  label: string;
}
