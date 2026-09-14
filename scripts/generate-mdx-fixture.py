#!/usr/bin/env python3
"""Regenerate `src-tauri/tests/fixtures/mini.mdx`.

Why a committed binary fixture instead of a fixture built in Rust: the MDict
reader is only as correct as the format description it was written from, so a
fixture assembled by the same understanding the reader encodes would agree with
a reader that is wrong. This one is produced by a **third-party writer**
(`writemdict`, vendored inside `mdict-utils`) and then read back by a
**third-party reader**, which is what makes "the fixture is a well-formed MDX
v2.0 file" a claim established by something other than the code under test.

    pip install mdict-utils
    python3 scripts/generate-mdx-fixture.py src-tauri/tests/fixtures/mini.mdx
    python3 -c "from mdict_utils.reader import MDX; \\
                print(sum(1 for _ in MDX('src-tauri/tests/fixtures/mini.mdx').items()))"
    # -> 44

The file is not byte-reproducible: the writer stamps `CreationDate` with today,
so regenerating produces a new file. What must stay stable is the *content* the
Rust tests assert on (44 entries; `apple`; `hello`; `markup`; `踟蹰`).
"""

import sys

from mdict_utils.base.writemdict import MDictWriter

out = sys.argv[1]

entries = {}
for i in range(1, 41):
    entries[f"word{i:03d}"] = f"释义 {i}"
entries["apple"] = "苹果"
entries["hello"] = "你好"
entries["markup"] = "<b>粗体</b>"
entries["踟蹰"] = "犹豫不前"

with open(out, "wb") as handle:
    MDictWriter(
        entries,
        title="迷你词典",
        description="fixture",
        # Small enough to force several key and record blocks, so the block
        # index walk is exercised by a file this size.
        block_size=256,
        encoding="utf8",
        compression_type=2,
        version="2.0",
    ).write(handle)

with open(out, "rb") as handle:
    raw = handle.read()
size = int.from_bytes(raw[:4], "big")
print(f"wrote {out}: {len(raw)} bytes")
print("header:", raw[4 : 4 + size].decode("utf-16-le").strip())
