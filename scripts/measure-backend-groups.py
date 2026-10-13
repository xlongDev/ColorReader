#!/usr/bin/env python3
"""Measure how `lib/local/backend.ts` splits along command domains.

The answer O7 needs is not "how many lines per domain" but "what would have to
stay shared": the private helpers two or more domains call. Those are the true
seams. Run with `--verbose` for the per-helper reference counts.
"""

from __future__ import annotations

import io
import re
import sys
from collections import defaultdict

BACKEND = "src/lib/local/backend.ts"

# Which top-level name belongs to which command domain. The command surface is
# the module's exports; the private helpers are attached to the domain that
# owns the rows they touch.
DOMAINS: dict[str, list[str]] = {
    "books": [
        "bookImportFiles", "importOne", "pdfPages", "describePdf",
        "bookList", "bookStats", "bookGet", "bookDelete", "bookSetFavorite",
        "bookDeleteMany", "bookSetFavoriteMany", "bookUpdate", "bookCoverSave",
        "savedName", "bookExport", "bookAsset", "stripRow",
    ],
    "reader": ["chaptersOf", "readerToc", "readerChapter", "bookImages", "readerSetProgress", "bookFile"],
    "annotations": [
        "annotationList", "annotationCreate", "annotationDelete", "annotationDeleteMany",
        "annotationPatch", "annotationUpdate", "annotationAnchor", "annotationNote",
    ],
    "bookmarks": ["bookmarkList", "bookmarkCreate", "bookmarkDelete"],
    "stats": [
        "STATS_WINDOW", "TOP_WINDOW", "sessions",
        "statsRecordSession", "statsReading", "statsClear", "inWindow",
    ],
    "tags": ["tagList", "bookSetTags", "tagDelete"],
    "search": ["SNIPPET", "snippetAround", "searchQuery", "hitsInBook"],
    "fonts": ["fontUrls", "fontUrlOf", "asLocalFont", "fontList", "fontImportFile", "fontDelete"],
    "dictionaries": [
        "MDICT", "dictionaryIndexes", "asLocalDictionary",
        "dictionaryList", "dictionaryImportFile", "dictionaryDelete", "lookupDictionary",
    ],
    "notes": [
        "notesDialect", "notesExtension", "notesType",
        "notesOf", "notesSave", "notesSaveSelection",
    ],
    "clippings": ["clippingsImportFile"],
    "rows": ["dayOf", "two", "now", "newId", "coverUrls", "coverOf", "coverUrlOf", "summaryOf", "bookRow", "patchBook"],
    "consts": ["SUMMARY_KEYS", "logger"],
    "types": ["StoredBook", "StoredFont", "StoredImage", "StoredDictionary", "Session"],
}

DECL = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=|^(?:export\s+)?interface\s+(\w+)|^(?:export\s+)?type\s+(\w+)")


def main() -> int:
    verbose = "--verbose" in sys.argv
    lines = io.open(BACKEND, encoding="utf-8").read().split("\n")

    # Collect the line span of each top-level declaration.
    spans: dict[str, tuple[int, int]] = {}
    current: str | None = None
    start = 0
    for i, line in enumerate(lines, 1):
        m = DECL.match(line)
        if m:
            name = next(g for g in m.groups() if g)
            if current:
                spans[current] = (start, i - 1)
            current, start = name, i
    if current:
        spans[current] = (start, len(lines))

    owner: dict[str, str] = {}
    for domain, names in DOMAINS.items():
        for name in names:
            if name in spans:
                owner[name] = domain
            else:
                print(f"!! {domain}: declared list has no `{name}` in {BACKEND}", file=sys.stderr)

    declared = set(spans)
    orphans = declared - set(owner)
    if orphans:
        print(f"!! top-level names with no domain: {sorted(orphans)}", file=sys.stderr)

    # Line counts per domain (declarations only; gaps are comments/blank).
    domain_lines: dict[str, int] = defaultdict(int)
    for name, (a, b) in spans.items():
        if name in owner:
            domain_lines[owner[name]] += b - a + 1
    declared_total = sum(domain_lines.values())

    # Who references whom: a name is "used" by a domain if it appears inside
    # that domain's own spans, outside its declaration line itself.
    refs: dict[str, set[str]] = defaultdict(set)
    for name, (a, b) in spans.items():
        dom = owner.get(name)
        if not dom:
            continue
        body = "\n".join(lines[a:b])
        for other in declared:
            if other == name:
                continue
            # whole-identifier match, skipping the declaration's own name
            if re.search(rf"(?<![\w$.]){re.escape(other)}(?![\w$])", body):
                refs[other].add(dom)

    shared = {n: sorted(d) for n, d in refs.items() if len(d) > 1}

    print(f"{BACKEND}: {len(lines)} lines, {len(spans)} top-level declarations")
    print(f"declared span lines: {declared_total}")
    print(f"\nlines per domain:")
    for dom, n in sorted(domain_lines.items(), key=lambda kv: -kv[1]):
        heads = [x for x in DOMAINS[dom] if x in spans]
        print(f"  {dom:14s} {n:5d}  ({len(heads)} declarations)")

    print(f"\nshared surface (referenced by 2+ domains): {len(shared)}")
    for name, doms in sorted(shared.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        tag = "→ move to rows" if owner.get(name) == "rows" else f"kept in {owner.get(name)}"
        print(f"  {name:20s} {' + '.join(doms):50s} {tag}")

    if verbose:
        print("\nper-helper reference detail:")
        for name in sorted(refs):
            print(f"  {name:20s} {owner.get(name, '?'):14s} {sorted(refs[name])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
