#!/usr/bin/env python3
"""Measure the shared surface between ReaderPage's three render branches.

O1's conclusion (2026-10-12) was that hook extraction is exhausted and the only
direction left is 「按渲染分支拆文件」— but it also said that direction has to
start by measuring how much the branches actually share. This script is that
measurement.

Method: every top-level statement in `ReaderView` is classified by which
branch-exclusive symbols it mentions.

  PDF      `isPdf`, `pdfSlotH`, `suppressPdfPending`, `pdfScrollPage`,
           `pdfZoom`/`stepPdfZoom`, `handlePdfLayout`, `onPdfSelection`,
           `onPdfAnnotationClick`, `outlineQuery`, `prevPaged`, `setPdfScrollPage`
  folio    `useFoliate`, `foliateRef`, `foliateToc`/`setFoliateToc`,
           `foliateSectionLabel`, `foliatePage`, `foliateBookPage`,
           `foliateChapters`, `foliateTocIdx`, `foliateStyle`,
           `foliateRulerLines`, `rememberFoliateLocation`, `onFoliate*`,
           `clearPaintedMatches`, `readsLeftward`, `startCfi`, `cfiKey`
  prose    `articleStyle`, `renderedParagraphs`, `markInk`, `plate`,
           `wallpaperPath`, `wallpaperUrl`, `zhConverter`, `PullBookmark`

A statement that mentions symbols of two branches is the *shared surface*: it
cannot move to either branch's file without the other branch's code moving with
it. What decides the split is therefore not the exclusive line count but the
multi-branch one — and, listed per statement, which functions those are.

Symbols are matched as whole identifiers, with the two pitfalls the cluster
script found: a property *key* is not a reference, and a member access
(`a.pdfZoom`) is not one either. `isPdf`/`useFoliate` are flags, not states, so
a statement reading one is branch-aware whatever else it says.

Usage:  python3 scripts/measure-reader-branches.py [--verbose]
"""
import re
import sys
from collections import defaultdict

SRC = "src/features/reader/ReaderPage.tsx"

STMT = re.compile(r"^  (?:(?:const|let)\s|if\s*\(|useEffect\(|useLayoutEffect\(|return\b)")

PDF = {
    "isPdf", "pdfSlotH", "suppressPdfPending", "pdfScrollPage", "setPdfScrollPage",
    "prevPaged", "pdfZoom", "stepPdfZoom", "pdfZoomAnimated", "handlePdfLayout",
    "onPdfSelection", "onPdfAnnotationClick", "outlineQuery", "outline",
    "setTtsWashRule", "snapshotPdfTurn", "EMPTY_OUTLINE",
}
FOLIO = {
    "useFoliate", "foliateRef", "foliateToc", "setFoliateToc", "foliateSectionLabel",
    "foliatePage", "foliateBookPage", "foliateChapters", "foliateTocIdx", "hasToc",
    "foliateStyle", "foliateRulerLines", "rememberFoliateLocation",
    "onFoliateSelection", "onFoliateAnnotationClick", "onFoliateAnchor",
    "clearPaintedMatches", "readsLeftward", "startCfi", "cfiKey",
}
PROSE = {
    "articleStyle", "renderedParagraphs", "markInk", "plate", "wallpaperPath",
    "wallpaperUrl", "zhConverter", "isProseParagraph", "PullBookmark",
}

BRANCHES = {"pdf": PDF, "folio": FOLIO, "prose": PROSE}
IDENT = re.compile(r"[\w$]+")


def body_range(lines):
    sig = next(i for i, l in enumerate(lines) if l.startswith("}: ReaderViewProps) {"))
    end = next(
        i for i, l in enumerate(lines[sig + 1 :], sig + 1)
        if re.match(r"^(export )?(function|const|type|interface) ", l)
    )
    return sig + 2, end


def branch_hits(text):
    """Which branch-exclusive symbols a statement mentions."""
    hits = defaultdict(set)
    for line in text.split("\n"):
        line = re.sub(r"//.*$", "", line)
        for m in IDENT.finditer(line):
            name = m.group(0)
            after = line[m.end():]
            before = line[: m.start()].rstrip()
            if before.endswith("."):
                continue
            if re.match(r"\s*:", after) and (before == "" or before[-1] in "{,"):
                continue
            for branch, symbols in BRANCHES.items():
                if name in symbols:
                    hits[branch].add(name)
    return {b: sorted(s) for b, s in hits.items()}


def first_decl(text):
    """The statement's leading name, for the verbose listing."""
    m = re.match(r"\s*(?:const|let)\s+([\w$]+)", text)
    if m:
        return m.group(1)
    m = re.match(r"\s*(useEffect|useLayoutEffect|if|return)\b", text)
    return m.group(1) if m else "(block)"


def measure():
    lines = open(SRC).read().split("\n")
    first, last = body_range(lines)
    starts = [i for i in range(first, last) if STMT.match(lines[i])]
    spans = list(zip(starts, starts[1:] + [last]))

    tally = defaultdict(int)
    tally_lines = defaultdict(int)
    multi = []
    total = last - first
    for a, b in spans:
        text = "\n".join(lines[a:b])
        hits = branch_hits(text)
        kind = ("multi" if len(hits) > 1 else
                "pdf" if "pdf" in hits else
                "folio" if "folio" in hits else
                "prose" if "prose" in hits else
                "universal")
        tally[kind] += 1
        tally_lines[kind] += b - a
        if len(hits) > 1:
            multi.append((a + 1, b - a, first_decl(text), {k: v for k, v in hits.items()}))

    print(f"ReaderView 主体: {first}–{last}（{total} 行）\n")
    print(f"{'类别':10} {'语句数':>6} {'行数':>6} {'占主体':>7}")
    for kind in ("universal", "prose", "pdf", "folio", "multi"):
        print(f"{kind:10} {tally[kind]:6} {tally_lines[kind]:6} "
              f"{tally_lines[kind] / total * 100:6.1f}%")
    print()

    exclusive = tally_lines["pdf"] + tally_lines["folio"] + tally_lines["prose"]
    print(f"分支专属合计 {exclusive} 行（{exclusive / total * 100:.1f}%）"
          f" · 共享面 {tally_lines['multi']} 行（{tally_lines['multi'] / total * 100:.1f}%）"
          f" · 与分支无关 {tally_lines['universal']} 行"
          f"（{tally_lines['universal'] / total * 100:.1f}%）\n")

    if "--verbose" in sys.argv:
        print("=== 多分支语句（拆分的共享面，按行数降序）===")
        for start, n, name, hits in sorted(multi, key=lambda m: -m[1]):
            where = " ".join(f"{b}:{'/'.join(s[:3])}{'…' if len(s) > 3 else ''}"
                             for b, s in hits.items())
            print(f"  {start:5} {n:4} 行  {name:32} {where}")
    else:
        top = sorted(multi, key=lambda m: -m[1])[:12]
        print("=== 共享面最大的语句（前 12，--verbose 看全部）===")
        for start, n, name, hits in top:
            where = " ".join(f"{b}:{'/'.join(s[:3])}{'…' if len(s) > 3 else ''}"
                             for b, s in hits.items())
            print(f"  {start:5} {n:4} 行  {name:32} {where}")


if __name__ == "__main__":
    measure()
