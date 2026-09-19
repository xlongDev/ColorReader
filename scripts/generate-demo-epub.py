#!/usr/bin/env python3
"""Regenerate `public/demo/page-numbers.epub`.

Why this exists: the browser fixture (`src/lib/demo.ts`) is a plain-text book,
so it never loads foliate, never paginates a section, and never reports the
`location` counter the whole-book page indicator reads. The one format whose
page numbers readers actually complained about therefore had no coverage in
`pnpm test:e2e` at all — a fix could pass the whole suite and still print the
wrong number on a real EPUB.

    python3 scripts/generate-demo-epub.py public/demo/page-numbers.epub

The fixture is deliberately **not** uniform: three long chapters against a
one-paragraph fourth. A book whose chapters are all the same length makes every
estimator look right, including the one that extrapolates the book from
whatever chapter is on screen — which is the defect the fixture has to be able
to show. It is a real EPUB 3 (nav document, `mimetype` first and stored), not a
filesystem-shaped stand-in, because foliate reads it exactly as it reads a
book off a reader's shelf.
"""

import sys
import zipfile

PARAGRAPHS = [
    "身体是一台被反复修补过的机器。演化并不设计，它只保留此刻还能留下的东西，所以每一处精妙旁边都躺着一处将就。",
    "咳嗽、发烧、呕吐，这些让人难受的反应大多是防御本身，而不是疾病。压掉它们往往是在帮倒忙。",
    "为什么自然选择没有把衰老剔除掉？因为选择在繁殖之后就放手了，晚年是一段没有选择压力的时光，于是损伤在那里慢慢堆积。",
    "我们的基因来自一个食物稀缺、寄生虫遍地的世界，如今坐在一个热量过剩、几乎无菌的世界里，错位本身就是病。",
    "医学擅长处理近因——哪一种细菌、哪一条通路；演化医学追问远因——为什么这套设计会被留下。两把钥匙开两把锁。",
    "理解这一点并不会立刻治好什么病，但它会改变提问的方式，而提问的方式决定了找得到什么答案。",
]

# Enough text to paginate into screens a reader walks through, and short enough
# that a spec can walk all of it inside its timeout.
CHINESE_CHAPTERS = [
    ("第一章 疾病的谜题", 40),
    ("第二章 防御与修复", 40),
    ("第三章 演化的遗留", 20),
    ("第四章 现代环境", 1),
]

XHTML = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>{title}</title></head>
<body>
<h1>{title}</h1>
{body}
</body>
</html>
"""

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>目录</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>{items}</ol></nav></body>
</html>
"""


def chapter_body(count: int) -> str:
    return "\n".join(f"<p>{PARAGRAPHS[i % len(PARAGRAPHS)]}</p>" for i in range(count))


def main(out: str) -> None:
    manifest, spine, nav_items = [], [], []
    for index, (title, _) in enumerate(CHINESE_CHAPTERS, start=1):
        name = f"ch{index}.xhtml"
        manifest.append(f'<item id="{name}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{name}"/>')
        nav_items.append(f'<li><a href="{name}">{title}</a></li>')

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:colorreader-page-numbers</dc:identifier>
    <dc:title>页码样书</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-09-19T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    {chr(10).join("    " + item for item in manifest)}
  </manifest>
  <spine>{chr(10).join("    " + item for item in spine)}</spine>
</package>
"""

    with zipfile.ZipFile(out, "w") as archive:
        # `mimetype` first and uncompressed: a reader checks those exact 20
        # bytes at byte 30 before it will look at anything else.
        archive.writestr(
            zipfile.ZipInfo("mimetype", (2026, 9, 19, 0, 0, 0)),
            "application/epub+zip",
            zipfile.ZIP_STORED,
        )
        archive.writestr("META-INF/container.xml", CONTAINER)
        archive.writestr("OEBPS/content.opf", opf)
        archive.writestr("OEBPS/nav.xhtml", NAV.format(items="".join(nav_items)))
        for index, (title, count) in enumerate(CHINESE_CHAPTERS, start=1):
            archive.writestr(
                f"OEBPS/ch{index}.xhtml",
                XHTML.format(title=title, body=chapter_body(count)),
            )

    # The indicator's whole-book count is foliate's size domain: the spine
    # documents' uncompressed bytes over 1500. Printed so a change to the
    # fixture's length is visible here rather than as a shifted page number in
    # a spec.
    with zipfile.ZipFile(out) as archive:
        spine_bytes = sum(
            item.file_size
            for item in archive.infolist()
            if item.filename.startswith("OEBPS/ch")
        )
    print(f"wrote {out}")
    print(f"spine documents: {spine_bytes} bytes → {spine_bytes / 1500:.1f} sizes")


if __name__ == "__main__":
    main(sys.argv[1])
