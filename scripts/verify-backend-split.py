#!/usr/bin/env python3
"""Prove the split moved code without changing it.

Every top-level declaration in HEAD's `backend.ts` must appear verbatim in
exactly one new file, modulo the `export` keyword some of them gained. Anything
else — a reflowed line, a dropped branch — shows up as a diff.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys

NEW = [
    "rows", "books", "reader", "annotations", "bookmarks",
    "stats", "tags", "search", "fonts", "dictionaries", "notesSave", "clippingsImport",
]
DECL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)"
    r"|^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?="
    r"|^(?:export\s+)?interface\s+(\w+)"
    r"|^(?:export\s+)?type\s+(\w+)"
)


def declarations(text: str) -> dict[str, str]:
    lines = text.split("\n")
    out: dict[str, str] = {}
    current: str | None = None
    start = 0
    for i, line in enumerate(lines, 1):
        m = DECL.match(line)
        if m:
            name = next(g for g in m.groups() if g)
            if current:
                out[current] = "\n".join(lines[start - 1 : i - 1]).strip("\n")
            current, start = name, i
    if current:
        out[current] = "\n".join(lines[start - 1 :]).strip("\n")

    # A span ran to the *next* declaration, so it carries that one's doc
    # comment, any section marker, and (in a split file) the next file's
    # imports. Drop all three, then compare with whitespace removed: prettier
    # may re-wrap a long signature, and what matters is that no token moved.
    # The one line that legitimately did move — the backup re-export, now in
    # `backend.ts` where the dispatch table lives — is checked separately.
    def body_only(text: str) -> str:
        kept: list[str] = []
        pending_import = False
        for line in text.split("\n"):
            stripped = line.strip()
            if stripped.startswith("import ") or pending_import:
                pending_import = not stripped.endswith(";")
                continue
            if stripped == "" or stripped.startswith(("*", "*/", "/*", "//")):
                if kept:
                    continue
            kept.append(stripped)
        # `,)` is prettier's trailing comma in a wrapped parameter list, and the
        # backup re-export is the one line that moved on purpose.
        return "".join("".join(kept).split()).replace(",)", ")").replace(
            'export{backupExportasbackupSave,backupRestoreasbackupLoad}from"@/lib/local/backup";', ""
        )

    return {k: body_only(re.sub(r"^export\s+", "", v)) for k, v in out.items()}


def main() -> int:
    head = subprocess.run(
        ["git", "show", "HEAD:src/lib/local/backend.ts"],
        capture_output=True, text=True, check=True,
    ).stdout
    old = declarations(head)

    new: dict[str, str] = {}
    for name in NEW:
        path = f"src/lib/local/{name}.ts"
        found = declarations(io.open(path, encoding="utf-8").read())
        for decl, body in found.items():
            if decl in new:
                print(f"!! {decl} declared in two files", file=sys.stderr)
                return 1
            new[decl] = body

    missing = sorted(set(old) - set(new))
    extra = sorted(set(new) - set(old))
    if missing:
        print(f"!! declarations left behind: {missing}", file=sys.stderr)
    if extra:
        print(f"!! declarations with no original: {extra}", file=sys.stderr)

    changed = []
    for decl in sorted(set(old) & set(new)):
        if old[decl] != new[decl]:
            changed.append(decl)
    if changed:
        print(f"!! declarations whose body changed: {changed}", file=sys.stderr)
        for decl in changed:
            import difflib
            print(f"\n--- {decl} ---", file=sys.stderr)
            for line in difflib.unified_diff(
                old[decl].split("\n"), new[decl].split("\n"), "HEAD", "split", lineterm=""
            ):
                print(line, file=sys.stderr)
        return 1

    table = io.open("src/lib/local/backend.ts", encoding="utf-8").read()
    assert 'export { backupExport as backupSave, backupRestore as backupLoad } from "@/lib/local/backup";' in table, "backup re-export left behind"
    print(f"{len(old)} declarations, {len(new)} found across {len(NEW)} files, all verbatim")
    return 0 if not (missing or extra) else 1


if __name__ == "__main__":
    raise SystemExit(main())
