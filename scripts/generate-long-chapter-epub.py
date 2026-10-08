#!/usr/bin/env python3
"""Generates two scroll-layout fixtures for the reading ruler.

`public/demo/long-chapter.epub` — three long, plain chapters whose only styling
is the books' own (no CSS at all, so foliate hands back the default book
typography: a leading tighter than the type is high, which is where the reading
ruler's scroll-mode geometry shows its real shape). The scrolled-layout tests
route this over `page-numbers.epub`: a screenful of prose is not enough to
reach the trigger line and keep stepping, and the tight-leading line grid is the
one that breaks pad-derived blocks.

`public/demo/sparse-opener.epub` — the shapes a slot would otherwise have to go
paging around looking for, one section each:

1. a chapter opener: a spacer, then a title with a couple of hundred pixels of
   clearance under it, then the prose. The ruler parks a fresh band on the title
   (the stored place is a third of the reading axis), and the first step off that
   title is the shape under test — the title's block must not swallow the
   paragraph's first line;
2. a **wordless** section: one image, no text node at all. 「这一页没有行 →
   什么都不画」 needs a page without text *by construction* — the sparse-title
   book only had one by accident (foliate renders its opener as an empty section
   on some platforms and not on others: a coin flip, not a fixture, and it is
   what made that slot red on CI);
3. a **one-paragraph** section: in 竖排 a paragraph is a column, so that is the
   short column a band's height has to be able to describe. Every other section
   here runs full-height columns, where 「band 的高度」 and 「页的高度」 are the
   same number and the slot cannot tell them apart;
4. plain prose, for coming back to.

`public/demo/plate-book.epub` and `public/demo/short-column.epub` — one shape
each, **first section**, so a slot that needs a wordless page or a one-line
vertical column gets it on the first screen instead of paging to it. Reaching a
shape by turning pages across sections is how the two slots below went red on the
Linux runner: the turn itself is the part that differs between platforms, and a
slot whose subject is 「no lines here」 should not also be a test of chapter
turning. Each book keeps one prose section so 「the band comes back with the
words」 has somewhere to come back to.

    python3 scripts/generate-long-chapter-epub.py
"""

import zipfile

PARA = (
    "她的婚姻以失败告终当然是个悲剧。此时此刻，她想必正在抱憾她思量多年前做出的"
    "那个决定是如何使得她在中年的后期落得如此孤独凄凉的。只要肯顿小姐愿意重返达"
    "林顿府并在那里一直工作到退休，我看这样的选择没有理由不会为她那已经充满了光"
    "阴虚掷、岁月蹉跎况味的人生带来一份真正的慰藉，这是毫无疑问的。"
)

CHAPTERS = 3
PARAS = 150

# 1×1 transparent PNG, inline: a plate with no text node is what 「这一页没有行」
# needs, and a real image beats an empty section (which foliate may or may not
# render as empty depending on the platform).
PLATE_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

# The opener's own geometry, in px — a fixed clearance rather than `vh`, which
# inside a scrolled section (whose height is its content) is a circular quantity
# foliate settles differently every time.
#
# Two constraints shape the numbers. The title sits at about a third of the
# first screen, which is where the ruler parks a fresh band (the stored place is
# a third of the reading axis). And the paragraph under it has to stay *above*
# the scrolled layout's trigger line, or the step off the title is absorbed by
# the page (it scrolls one block and holds the band) instead of walking — which
# is the other half of what this fixture exists to hold still. The clearance
# itself must still exceed one and a half leads, or the title and the paragraph
# are neighbours and there is no sparse shape to catch.
OPENER_SPACER = 150
OPENER_TITLE_CLEARANCE = 80


def _write(path: str, chapters: list[str], title: str) -> None:
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">{title}</dc:identifier><dc:title>{title}</dc:title><dc:language>zh</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{''.join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, len(chapters) + 1))}</manifest>
<spine>{''.join(f'<itemref idref="c{i}"/>' for i in range(1, len(chapters) + 1))}</spine></package>"""
    nav = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>{''.join(f'<li><a href="c{i}.xhtml">第{i}章</a></li>' for i in range(1, len(chapters) + 1))}</ol></nav></body></html>"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        for i, chapter in enumerate(chapters, 1):
            z.writestr(f"OEBPS/c{i}.xhtml", chapter)


def main() -> None:
    def chapter(index: int) -> str:
        body = "\n".join(
            f"    <p>{PARA}（第{index}章第{i}段）</p>" for i in range(1, PARAS + 1)
        )
        return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第{index}章</title></head>
<body><h1>第{index}章 长日将尽</h1>
{body}
</body></html>"""

    _write("public/demo/long-chapter.epub", [chapter(i) for i in range(1, CHAPTERS + 1)], "长章样书")

    def section(title: str, body: str) -> str:
        return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head>
<body>
{body}
</body></html>"""

    opener_body = "\n".join(f"  <p>{PARA}（第{i}段）</p>" for i in range(1, 7))
    opener = section(
        "第一章 开篇",
        f"""  <div style="height:{OPENER_SPACER}px"></div>
  <h1 style="margin:0 0 {OPENER_TITLE_CLEARANCE}px 0">第一章 开篇</h1>
{opener_body}""",
    )
    # One **line**: in 竖排 a paragraph is a column, and this is a short one.
    # A long paragraph would not do — it wraps, and the ruler's block is two lines
    # whatever the page holds.
    prose_body = "\n".join(f"  <p>{PARA}（第{i}段）</p>" for i in range(1, 13))

    # sparse-opener keeps the opener alone: the slots that want a wordless page
    # or a short column have books of their own, where that shape is the *first*
    # section rather than two turns away.
    _write("public/demo/sparse-opener.epub", [opener, section("第二章 正文", prose_body)], "开篇样书")

    # A plate: one image, not a text node. 1×1 PNG, inline so the section carries
    # nothing else — `lineRects` only ever reads text, so this page has no lines
    # on every platform.
    _write(
        "public/demo/plate-book.epub",
        [
            section("图版", f'  <img src="data:image/png;base64,{PLATE_PNG}" alt=""/>'),
            section("正文", prose_body),
        ],
        "图版样书",
    )
    # One **line**: in 竖排 a paragraph is a column, and this is a short one. Its
    # own page, which is the point — every other section here runs full-height
    # columns, and only beside one of those can a band's height be told apart
    # from the page's.
    short = section("短章", "  <p>短章仅此一行。</p>")
    _write(
        "public/demo/short-column.epub",
        [short, section("第二章 正文", prose_body)],
        "短列样书",
    )


if __name__ == "__main__":
    main()
