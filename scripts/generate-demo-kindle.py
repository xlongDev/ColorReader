#!/usr/bin/env python3
"""Regenerate `public/demo/kindle-pages.azw3`.

Why this exists: `src/lib/demo.ts` ships a real EPUB and a real PDF, so the
foliate and pdf.js surfaces are reachable from a browser — but no *Kindle*
container ever was. That is the one family whose whole reason for existing in
this reader is that it does **not** go through the prose pipeline: it is handed
to foliate because foliate reassembles the book's own XHTML and CSS. So the
claim "an AZW3 book renders" had been verified down to the Rust importer (which
reads metadata and splits chapters) and not one step further. `?demo=1&kindle=1`
closes the rest of the way: the shelf entry is `format: "azw3"`, the reader
picks foliate from that, and this file is what foliate actually parses.

    python3 scripts/generate-demo-kindle.py public/demo/kindle-pages.azw3

**A MOBI6, deliberately.** AZW3 is KF8 — a different generation of the same PDB
container, and the generation that needs the INDX/skel/frag machinery to be
reassembled. Building that here would mean synthesising four kinds of index
record to prove something the fixture is not there to prove: that the *reader*
routes a Kindle book to foliate. So the version field says 6 and the text is one
flat run of HTML, which is what a pre-KF8 Mobipocket file is. foliate's
`MOBI.open` reads `version >= 8` to choose its parser, and this file takes the
MOBI6 branch — the same branch a `.mobi` takes, which is exactly the point:
AZW3 and MOBI share a parser, so exercising one exercises both.

Three things the byte layout has to get right, all of them read by
`src/vendor/foliate-js/mobi.js`:

- `"BOOKMOBI"` at bytes 60..68. This is the *only* thing `makeBook` sniffs to
  decide a file is a Kindle container (`isMOBI`), and it is checked before
  anything else in the file is looked at.
- The EXTH block starts at `mobiHeaderLength + 16` — foliate reads the length
  out of the header and slices there, so the title and the metadata records have
  to sit immediately after a 232-byte header and not one byte off.
- `compression = 1` (stored, not compressed). The PalmDOC decompressor is a
  second code path, and `huffcdic` would need a Huffman table; neither is what
  this fixture is for.

The body is explanatory prose on purpose, in the style of the other two
fixtures: the text of a fixture is the one thing a reader sees when something
goes wrong, and a paragraph about what the file is beats "lorem ipsum" as a
diagnosis.
"""

import struct
import sys

# --- Palm database ---------------------------------------------------------

PDB_HEADER_LEN = 78
RECORD_INFO_LEN = 8
RECORD_SIZE = 4096

# --- PalmDOC header (record 0, bytes 0..16) --------------------------------

COMPRESSION_NONE = 1
ENCODING_UTF8 = 65001
EXTH_FLAG = 0x40

# --- MOBI header (record 0, bytes 16..16 + length) -------------------------
#
# The length field counts the header including the PalmDOC prefix, so the
# header ends at `16 + 232` and foliate's EXTH slice (`length + 16`) lands
# exactly on the `"EXTH"` magic below.

MOBI_HEADER_LEN = 232
FIXED = 16 + MOBI_HEADER_LEN
VERSION = 6
ABSENT = 0xFFFFFFFF

# 4 = Chinese, region 8 >> 2 = 2 -> 'zh-CN' in foliate's MOBI_LANG table.
LOCALE_LANGUAGE = 4
LOCALE_REGION = 8

# --- Text ------------------------------------------------------------------

PAGEBREAK = "<mbp:pagebreak/>"

TITLE = "Kindle 样书"

SECTIONS: list[tuple[str, list[str]]] = [
    (
        "第一章 同一个容器",
        [
            "AZW3 与 MOBI 是同一个容器：同一个 PDB 外壳，同一张记录表，连解析器都是同一个，差别只在代次。",
            "所以书架把一本 AZW3 标成 MOBI 曾经是「说得通」的——它们确实共享一条渲染路径，共享到连一个字节都不必改写。",
            "但读者手里拿到的是 .azw3，货架上写着 MOBI，两个名字对不上就是错。共用一条路径和共用一个名字是两件事。",
            "这也是这本样书存在的理由：既然一本 AZW3 走的是 foliate 而不是我们自己的段落管道，那就得有一本真的 AZW3 走一遍。",
            "在此之前，「AZW3 能渲染」这句话只被验证到导入器为止——读得出元数据、切得开章节，再往后的每一步都只是推断。",
            "而推断在这里尤其站不住：foliate 拿到的是书自己的 XHTML 和 CSS，它要重新拼回设计者想要的那一页，这条路和抽文字完全是两回事。",
            "样书因此是 MOBI6，不是 KF8。KF8 要 INDX、skel、frag 四套索引记录才能拼装，而这里要证的只是「读一本书」这一步。",
            "版本号写 6，正文就是一整段 HTML，foliate 读到版本小于 8 就走 MOBI6 分支——和一本 .mobi 走的是同一条。",
        ],
    ),
    (
        "第二章 三段正文",
        [
            "正文用 pagebreak 标记切成三段。foliate 在字节流里找这个标记，每一段成为一个独立的 section，各自渲染在自己的文档里。",
            "这就是 Kindle 书的分节方式：没有 spine，没有 manifest，只有一条连续的字节流和几个分隔符，章节边界靠约定而不是靠清单。",
            "所以同一本书在 foliate 里的 section 编号，和导入器从 EXTH 边界或 NCX 里读出来的章节号对不上——这也是阅读位置只能按整本比例存的原因。",
            "段落足够多，书才会被分成不止一页。一页的样书会让任何页码估算看起来都对，而那正是这个项目里踩过的坑。",
        ],
    ),
    (
        "第三章 页数",
        [
            "翻到最后一段，页数应当停在总页数上，而且中途不该变。",
            "foliate 按书的字节数编号，这是量出来的，不是估的，所以页码指示器不该带「约」。",
            "如果它带了「约」，说明这本书根本没走到 foliate——它掉回了纯文本管道，而那正是这本样书要拦住的事。",
        ],
    ),
]


def exth_block(records: list[tuple[int, str | bytes]]) -> bytes:
    """The EXTH metadata block: magic, length, count, then the records."""
    body = b""
    for kind, value in records:
        payload = value if isinstance(value, bytes) else value.encode("utf-8")
        body += struct.pack(">II", kind, len(payload) + 8) + payload
    return b"EXTH" + struct.pack(">II", len(body) + 12, len(records)) + body


def put(buffer: bytearray, offset: int, size: int, value: int | bytes) -> None:
    """Writes a big-endian integer, or raw bytes, at an absolute offset."""
    raw = value if isinstance(value, bytes) else value.to_bytes(size, "big")
    buffer[offset : offset + size] = raw


def body_html() -> bytes:
    """The book's whole text: one run of HTML with pagebreaks between parts."""
    parts = []
    for index, (heading, paragraphs) in enumerate(SECTIONS):
        section = [f"<h1>{heading}</h1>"]
        section.extend(f"<p>{paragraph}</p>" for paragraph in paragraphs)
        # Only the first part opens the document; the rest are fragments, which
        # is what a Kindle text stream actually looks like and which the HTML
        # parser closes for us.
        if index == 0:
            section.insert(0, f"<html><head><title>{TITLE}</title></head><body>")
        parts.append("".join(section))
    # Closed onto the last section rather than appended as another part: every
    # element of `parts` is one section, and the join below is what says so.
    parts[-1] += "</body></html>"

    html = PAGEBREAK.join(parts)
    # The break is the *only* thing that makes a section, so the count is worth
    # asserting: joining one level too deep silently turns every paragraph into
    # its own section, and the file still parses and still renders.
    assert html.count(PAGEBREAK) == len(SECTIONS) - 1, "pagebreak count is not the section count"
    return html.encode("utf-8")


def header_record(title: str, text_length: int) -> bytes:
    """Record 0: PalmDOC header, MOBI header, EXTH block, then the full name."""
    block = exth_block(
        [
            (100, "样书"),  # creator
            (503, title),  # title
            # The record number the KF8 half starts at. `0xffffffff` is "there
            # is none", which is what keeps foliate from trying to open a KF8
            # half of this file.
            (121, struct.pack(">I", ABSENT)),
        ]
    )
    name = title.encode("utf-8")

    head = bytearray(FIXED)
    put(head, 0, 2, COMPRESSION_NONE)
    put(head, 4, 4, text_length)
    put(head, 8, 2, 1)  # numTextRecords: the whole book in one record
    put(head, 10, 2, RECORD_SIZE)
    put(head, 16, 4, b"MOBI")
    put(head, 20, 4, MOBI_HEADER_LEN)
    put(head, 24, 4, 2)  # type: book
    put(head, 28, 4, ENCODING_UTF8)
    put(head, 32, 4, 1)  # uid, which foliate reports as the identifier
    put(head, 36, 4, VERSION)
    put(head, 84, 4, FIXED + len(block))  # titleOffset, past the EXTH block
    put(head, 88, 4, len(name))
    put(head, 94, 1, LOCALE_REGION)
    put(head, 95, 1, LOCALE_LANGUAGE)
    put(head, 108, 4, ABSENT)  # no image records
    put(head, 128, 4, EXTH_FLAG)
    # trailingFlags stays 0, so foliate strips nothing off the text records —
    # the fields it reads there are "how many multi-byte trailers to remove",
    # and this file writes none.
    put(head, 244, 4, ABSENT)  # no INDX record

    return bytes(head) + block + name


def build_pdb(records: list[bytes]) -> bytes:
    """Wraps records in a Palm database: header, record table, then the data."""
    out = bytearray(PDB_HEADER_LEN)
    out[0:11] = b"KindlePages"
    out[60:64] = b"BOOK"
    out[64:68] = b"MOBI"
    put(out, 68, 4, 1)  # unique id seed
    put(out, 76, 2, len(records))

    at = PDB_HEADER_LEN + len(records) * RECORD_INFO_LEN
    for record in records:
        # Only the offset is read; the attribute byte and the unique id that
        # follow it are not.
        out += struct.pack(">II", at, 0)
        at += len(record)

    for record in records:
        out += record
    return bytes(out)


def build() -> bytes:
    """The whole fixture: record 0's header plus the one text record."""
    text = body_html()
    return build_pdb([header_record(TITLE, len(text)), text])


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else "public/demo/kindle-pages.azw3"
    data = build()
    with open(target, "wb") as handle:
        handle.write(data)
    print(f"wrote {target} ({len(data)} bytes, {len(SECTIONS)} sections)")


if __name__ == "__main__":
    main()
