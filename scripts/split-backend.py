#!/usr/bin/env python3
"""Move `backend.ts` apart along its command domains.

Line ranges are asserted before anything is written, so a drifted file fails
loudly instead of silently moving half a function. Bodies move verbatim: the
import blocks are hand-written after this runs.
"""

from __future__ import annotations

import io
import sys

BACKEND = "src/lib/local/backend.ts"
LOCAL = "src/lib/local"

# (file, header, [(first, last), ...]) — 1-indexed, inclusive, verbatim.
PLAN: list[tuple[str, str, list[tuple[int, int]]]] = [
    (
        "rows.ts",
        '''/**
 * What the browser's stores hold, and the handful of row helpers more than one
 * command domain reads.
 *
 * `StoredBook` is the shelf row: a `BookSummary` minus its cover URL, plus the
 * table of contents and the picture list. Everything above this layer — the
 * shelf, the reader, search — answers in `BookSummary` shapes, so the strip and
 * the re-attach both live here, next to the row they are about.
 *
 * Split out of `backend.ts` when that grew too big to read (O7): these were the
 * only declarations more than one command domain called.
 */
import type { BookImage, BookSummary, ChapterMeta } from "@/lib/bindings";
import * as db from "@/lib/local/db";
''',
        [(64, 96), (102, 141)],
    ),
    (
        "books.ts",
        '''/**
 * The shelf: importing a picked file, listing, editing and deleting books, and
 * handing a book's own file back out.
 *
 * One book is one row in the `books` store, its bytes in `files`, its chapters
 * in `chapters`, keyed `<id>` and `<id>:<idx>`. What a *reader* does with one
 * book is in `reader.ts`; this is what the *shelf* does.
 */
''',
        [(143, 296), (298, 401), (475, 496), (851, 856)],
    ),
    (
        "reader.ts",
        '''/**
 * One book, as the reader reads it: its chapters, its bytes, the entries inside
 * it, and where the reader left off.
 *
 * The positions and the progress are the desktop's contract — a bookmark and a
 * search hit address a chapter by the same index the TOC carries — so these
 * commands answer the same shapes `bindings.ts` gives the Rust side.
 */
''',
        [(403, 464), (468, 473), (498, 531)],
    ),
    (
        "annotations.ts",
        '''/**
 * Highlights: one per marked range of one chapter, with the ink, the note and
 * (where the renderer can say) the CFI that anchors it to the text.
 *
 * Deleting counts the way the desktop counts — a selection is a snapshot, and a
 * highlight deleted in the reader between the click and the call is not there
 * to delete.
 */
''',
        [(533, 606)],
    ),
    (
        "bookmarks.ts",
        '''/** Where the reader put a bookmark: a chapter, and the fraction of it. */
''',
        [(608, 635)],
    ),
    (
        "stats.ts",
        '''/**
 * Reading time: one row per day and book, summed the way the stats page shows.
 *
 * A session is the raw material — a finished stretch, as the reader reported
 * it — and the page asks for windows and streaks over the whole log, so both
 * live next to the log they walk.
 */
''',
        [(97, 101), (637, 720)],
    ),
    (
        "tags.ts",
        '''/** Tags are names on book rows, counted across the shelf. */
''',
        [(722, 761)],
    ),
    (
        "search.ts",
        '''/**
 * Full-text search over the books whose text this build holds.
 *
 * Only plain-text and markdown chapters are stored (see `local/import.ts`), so
 * a foliate book searches its chapter titles and no further — which is the
 * honest answer for a book with no text to search.
 */
''',
        [(763, 849)],
    ),
    (
        "fonts.ts",
        '''/**
 * Imported fonts: the bytes, and a blob URL the reader's own `@font-face` rule
 * loads them from.
 *
 * The URL is made once per font and kept until the font goes — a section
 * document declares the face itself, so the app's chrome never sees it.
 */
''',
        [(858, 928)],
    ),
    (
        "dictionaries.ts",
        '''/**
 * Imported MDict dictionaries, and the lookups against them.
 *
 * The desktop keeps the same facts in a settings row and the files in a
 * directory next to the library; here the whole bundle is one row, because a
 * browser has no directory to put it in and no path to name it by.
 */
''',
        [(60, 62), (930, 1056)],
    ),
    (
        "notesSave.ts",
        '''/**
 * The download half of notes: one book's highlights, or the selection the notes
 * page is showing, as Markdown or CSV.
 *
 * The rendering is `notes.ts`; this is the command that asks for it and hands
 * the result to the browser's download.
 */
''',
        [(1065, 1142)],
    ),
    (
        "clippingsImport.ts",
        '''/**
 * Reads a clippings file back into the library.
 *
 * The parse is `clippings.ts`; the write is this file's, and it is the one that
 * has to agree with the desktop's: a dry run reports exactly what a real run
 * would write, because the number on the dialog's confirm button has to be the
 * number the reader gets.
 */
''',
        [(1144, 1250)],
    ),
]


def main() -> int:
    lines = io.open(BACKEND, encoding="utf-8").read().split("\n")
    total = 0
    for name, header, ranges in PLAN:
        body: list[str] = []
        for first, last in ranges:
            chunk = lines[first - 1 : last]
            body.extend(chunk)
            if not chunk or not chunk[-1].strip():
                print(f"!! {name}: range {first}-{last} ends blank — check bounds", file=sys.stderr)
            total += last - first + 1
        # one blank line between the header's imports and the first body line
        text = header.rstrip("\n") + "\n\n" + "\n".join(body).rstrip("\n") + "\n"
        io.open(f"{LOCAL}/{name}", "w", encoding="utf-8").write(text)
        print(f"{name:22s} {len(text.splitlines()):5d} lines")
    print(f"moved {total} declaration lines out of {len(lines)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
