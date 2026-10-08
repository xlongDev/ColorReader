#!/usr/bin/env python3
"""Generates two scroll-layout fixtures for the reading ruler.

`public/demo/long-chapter.epub` — three long, plain chapters whose only styling
is the books' own (no CSS at all, so foliate hands back the default book
typography: a leading tighter than the type is high, which is where the reading
ruler's scroll-mode geometry shows its real shape). The scrolled-layout tests
route this over `page-numbers.epub`: a screenful of prose is not enough to
reach the trigger line and keep stepping, and the tight-leading line grid is the
one that breaks pad-derived blocks.

`public/demo/sparse-opener.epub` — one chapter that opens the way a real one
does: a spacer, then a title with a couple of hundred pixels of clearance under
it, then the prose. The ruler parks its band on the title (which sits at about a
third of the way down the first screen, so the stored place lands on it), and
the first step off that title is the shape under test: the title's block must
not swallow the paragraph's first line.

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

    opener_body = "\n".join(f"    <p>{PARA}（第{i}段）</p>" for i in range(1, 7))
    opener = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body>
  <div style="height:{OPENER_SPACER}px"></div>
  <h1 style="margin:0 0 {OPENER_TITLE_CLEARANCE}px 0">第一章 开篇</h1>
{opener_body}
</body></html>"""
    _write("public/demo/sparse-opener.epub", [opener], "开篇样书")


if __name__ == "__main__":
    main()
