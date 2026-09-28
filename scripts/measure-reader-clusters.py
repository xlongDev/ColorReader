#!/usr/bin/env python3
"""Measure candidate extraction clusters in ReaderPage's ReaderView.

The method, and the four ways it lies if you get it wrong — all four cost a
false reading before this script was right:

1. Multi-line destructures. `const { on: autoScrollOn } = useAutoScroll({...})`
   read from its first line yields no bound names, and the *keys* (`on`, `stop`,
   `zoom`) then look like external inputs. Read the whole statement to the
   matching brace, and treat `key: alias` as binding only `alias`.
2. `useState`'s setter shares its statement with the state. Counting
   `setLightboxPath` as an external input is wrong; the test is whether the
   name's *declaring statement* is inside the cluster.
3. Do NOT "adopt" statements. A rule like "a statement outside the cluster that
   references two of its members belongs to it" converges on the JSX block
   (which references everything) and swallows it into every cluster — every
   reading becomes in≈120 / out≈0 and the ranking is meaningless. Read the
   per-symbol breakdown instead and judge by hand which references sit in an
   adjacent effect that belongs to the cluster.
4. Property names look like variable names. `{ chapterIdx: section ?? 0 }`
   counts as a reference to `chapterIdx`.

Two numbers decide a seam:

  inputs  = declarations read inside the cluster but declared outside it
  outputs = references to the cluster from outside it

A cluster is worth extracting when **outputs ≤ ~2 per consumer** and the inputs
are plain values. Clusters whose symbols are mostly referenced outside are the
component's spine: extracting them lifts the declarations one level and threads
every reference back.

Usage:  python3 scripts/measure-reader-clusters.py [--clusters-only]
"""
import re
import sys
from collections import defaultdict

SRC = "src/features/reader/ReaderPage.tsx"

STMT = re.compile(r"^  (?:(?:const|let)\s|if\s*\(|useEffect\(|useLayoutEffect\(|return\b)")

# Candidate clusters, by the names they declare. `foliateRef` and the other
# shared handles are deliberately listed where they are *used*, not where they
# belong — a shared handle is an input to whichever cluster reads it.
CLUSTERS = {
    "图片/灯箱": [
        "lightboxPath", "webImages", "bookImages", "lightboxIdx",
        "openImageAt", "stepLightbox", "openBookImage",
    ],
    "阅读标尺": [
        "rulerRef", "rulerSettleRef", "rulerDirRef", "remeasureSelection", "foliateRulerLines",
    ],
    "PDF": [
        "pdfSlotH", "suppressPdfPending", "pdfScrollPage", "prevPaged", "handlePdfLayout",
        "onPdfSelection", "onPdfAnnotationClick", "outlineQuery", "pdfZoom", "stepPdfZoom",
    ],
    "标注桥接": ["annotationsByPage", "pending", "deepLinkTarget", "markInk"],
    "翻页手势": [
        "dragState", "flipHint", "flipHintTimer", "lastPointer", "revealFlipHint",
        "revealFlipHintOnMove", "flip", "pageStep",
    ],
    "头部视图": ["useFoliateToc", "headerIndex", "headerTotal", "headerChapter", "chapterTitle"],
    "搜索/AI 跳转": ["focusOffset", "pickHit", "jumpToCitation"],
    "foliate 桥": [
        "foliateToc", "foliateSectionLabel", "foliatePage", "foliateBookPage", "foliateRef",
        "foliateSaveRef", "rememberFoliateLocation", "foliateStyle", "foliateChapters",
        "foliateTocIdx", "onFoliateSelection", "onFoliateAnnotationClick", "onFoliateAnchor",
        "clearPaintedMatches", "readsLeftward",
    ],
    "位置与导航": [
        "start", "chapterIdx", "displayProgress", "fraction", "nav", "pendingScroll",
        "pendingFocus", "fractionRef", "chapterIdxRef", "goTo", "jumpTo", "applyPending",
        "stepChapter", "saveProgress", "onScroll", "debounceRef", "autoAdvance", "onChapterEnd",
    ],
}

IDENT = re.compile(r"[\w$]+")


def body_range(lines):
    """ReaderView's body, 1-based inclusive: from its props' closing brace to
    the next top-level declaration."""
    sig = next(i for i, l in enumerate(lines) if l.startswith("}: ReaderViewProps) {"))
    end = next(
        i for i, l in enumerate(lines[sig + 1 :], sig + 1)
        if re.match(r"^(export )?(function|const|type|interface) ", l)
    )
    return sig + 2, end


def decl_names(text):
    """Names a `const`/`let` statement binds (see pitfalls 1 and 2)."""
    m = re.match(r"\s*(?:const|let)\s+(.*)$", text, re.S)
    if not m:
        return []
    rest = m.group(1).lstrip()
    if rest[0] in "{[":
        depth = 0
        inside = rest[1:]
        for i, ch in enumerate(rest):
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    inside = rest[1:i]
                    break
        inside = re.sub(r"([\w$]+)\s*:\s*", "", inside)  # `on: autoScrollOn` -> `autoScrollOn`
        inside = re.sub(r"=\s*[^,}]+", "", inside)  # drop defaults
        return [n for n in re.findall(IDENT, inside) if n not in ("const", "let")]
    m2 = re.match(r"([\w$]+)", rest)
    return [m2.group(1)] if m2 else []


def measure():
    lines = open(SRC).read().split("\n")
    first, last = body_range(lines)

    starts = [i for i in range(first, last) if STMT.match(lines[i])]
    stmts = [
        {"start": a + 1, "end": b, "decls": decl_names("\n".join(lines[a:b]))}
        for a, b in zip(starts, starts[1:] + [last])
    ]
    home = defaultdict(list)
    for s in stmts:
        for n in s["decls"]:
            home[n].append((s["start"], s["end"]))

    use = defaultdict(list)
    for i in range(first - 1, last):
        line = re.sub(r"//.*$", "", lines[i])
        for m in IDENT.finditer(line):
            name = m.group(0)
            # Pitfall 4: a property *key* is not a reference to the variable of
            # the same name. `{ chapterIdx: section ?? 0 }` reads as a use of
            # `chapterIdx`; a key is an identifier followed by `:` and preceded
            # by `{` or `,`. A property *access* (`a.chapterIdx`) is not one
            # either — an identifier preceded by `.` is a member name.
            after = line[m.end() :]
            before = line[: m.start()].rstrip()
            if before.endswith("."):
                continue
            if re.match(r"\s*:", after) and (before == "" or before[-1] in "{,"):
                continue
            use[name].append(i + 1)

    rows = []
    for label, names in CLUSTERS.items():
        spans = sorted(sp for n in names for sp in home.get(n, []))
        if not spans:
            print(f"!! {label}: no declarations resolved")
            continue
        merged = [list(spans[0])]
        for a, b in spans[1:]:
            if a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        inside = lambda n: any(a <= n <= b for a, b in merged)  # noqa: E731

        outs = {n: sum(1 for ln in use.get(n, []) if not inside(ln)) for n in names}
        # An input is a name whose *declaring statement* is outside the cluster
        # (pitfall 2) that the cluster reads.
        ins = set()
        for s in stmts:
            if any(a <= s["start"] and s["end"] <= b for a, b in merged):
                continue
            for n in s["decls"]:
                if n in names:
                    continue
                if any(inside(ln) for ln in use.get(n, [])):
                    ins.add(n)
        rows.append(
            {
                "label": label,
                "lines": sum(b - a + 1 for a, b in merged),
                "inputs": sorted(ins),
                "outs": {k: v for k, v in outs.items() if v},
                "spans": [f"{a}-{b}" for a, b in merged],
            }
        )

    rows.sort(key=lambda r: len(r["inputs"]) + sum(r["outs"].values()))
    print(f"{'cluster':12} {'lines':>5} {'in':>3} {'out':>4}  in+out")
    for r in rows:
        print(
            f"{r['label']:12} {r['lines']:5} {len(r['inputs']):3} {sum(r['outs'].values()):4} "
            f"{len(r['inputs']) + sum(r['outs'].values()):6}"
        )
    print()
    for r in rows:
        print(
            f"--- {r['label']}: lines={r['lines']} "
            f"in={len(r['inputs'])} out={sum(r['outs'].values())} ---"
        )
        print("    in   :", ", ".join(r["inputs"]) or "(none)")
        print(
            "    out  :",
            ", ".join(f"{k}×{v}" for k, v in sorted(r["outs"].items(), key=lambda kv: -kv[1]))
            or "(none)",
        )
        print("    spans:", ", ".join(r["spans"]))


if __name__ == "__main__":
    if "--clusters-only" in sys.argv:
        for name in CLUSTERS:
            print(name)
    else:
        measure()
