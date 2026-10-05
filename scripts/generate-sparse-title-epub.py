#!/usr/bin/env python3
"""Regenerate `public/demo/sparse-title.epub`.

Why this exists: the reading ruler had three rounds of "fixed" that all passed
the suite, because every fixture in it has *dense, evenly leaded* prose. A block
of lines there is barely taller than the band drawn over it, so a band centred on
the block and a band running from its leading edge are indistinguishable — and
the bug this fixture exists to catch is exactly the case where they differ.

Real books are not like that. A chapter opener is a title centred in
three-quarters of a blank page (`.chapter-title { min-height: 72vh; display:
flex; justify-content: center }`), and the first paragraph sits far below it. The
lines are hundreds of pixels apart, so a band centred on the block lands *in the
gap between them* — on blank paper, below the words it was marking — and takes
its width from everything in the block rather than from the lines it covers.

Found on 《AI未来已来》 (a real EPUB, 16 chapters, every one opening this way);
the demo fixture and the demo prose both hid it for three rounds.

    python3 scripts/generate-sparse-title-epub.py public/demo/sparse-title.epub

A real EPUB 3 (nav document, `mimetype` first and stored), because foliate reads
it exactly as it reads a book off a reader's shelf.
"""

import sys
import zipfile

# One title page, then one page of prose — enough to page on to, so a spec can
# leave the title and come back.
TITLE = "自序：一封泛黄的信"

PARAGRAPHS = [
    "一九三〇年代的某个下午，我在.library 的窗边读到一封很旧的信，信里说人这一生会失去很多东西，"
    "但真正失去的只有一样，就是妄自尊大。",
    "那封信没有署名，年份也不清楚，可我后来反复想起它，大概是因为它说中了一件我花了很久才肯承认的事。",
    "承认之后，剩下的事情就简单了：把「我知道」换成「我不知道」，然后把剩下的时间用来把不知道变成知道。",
    "这也是这本书想说的全部内容——不是结论，是方法。",
]

# The shape under test: a title centred in most of the page, the text far below
# it. `min-height` on a flex column with `justify-content: center` is how real
# books write a chapter opener, and it is what puts hundreds of pixels of nothing
# between the two lines the ruler has to choose between.
CSS = """@charset "utf-8";
body { font-family: "Noto Serif CJK SC", "Songti SC", serif; line-height: 1.75;
       margin: 5%; color: #202124; }
p { margin: 0.78em 0; text-align: justify; text-indent: 2em; }
h1 { font-size: 1.72em; line-height: 1.38; text-align: center; margin: 1.2em 0; }
.chapter-title { min-height: 72vh; display: flex; flex-direction: column;
                 justify-content: center; text-align: center; break-after: page;
                 page-break-after: always; }
/* A plate is a whole page of nothing: no text node at all, so there is no box
   for the ruler to measure and no line for it to sit on. `height` rather than
   `min-height`, so it fills whatever the page is and does not push the section
   that follows off the end of it. */
.plate { height: 100%; break-after: page; page-break-after: always; }
.plate svg { display: block; width: 100%; height: 100%; }
"""

# A whole page with no text node in it at all — a plate, a cover, a full-page
# diagram. Not an `<img>`: an image is a box, and the ruler would have something
# to measure. Nothing at all is the case a reader notices, and it is a section of
# its own so that it is a *page* of its own rather than the top of the opener's.
PLATE = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>插图</title><link rel="stylesheet" href="style.css"/></head>
<body>
<section class="plate">
  <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <rect width="100" height="100" fill="#e8e6e1"/>
  </svg>
</section>
</body>
</html>
"""

XHTML = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>{title}</title><link rel="stylesheet" href="style.css"/></head>
<body>
<section class="chapter-title"><h1>{title}</h1></section>
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
<body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="ch1.xhtml">{title}</a></li></ol></nav></body>
</html>
"""


def main(out: str) -> None:
    body = "\n".join(f"<p>{p}</p>" for p in PARAGRAPHS)
    nav_items = (
        '<li><a href="plate.xhtml">插图</a></li>'
        f'<li><a href="ch1.xhtml">{TITLE}</a></li>'
    )

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:colorreader-sparse-title</dc:identifier>
    <dc:title>稀疏标题页样书</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-10-05T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="plate.xhtml" href="plate.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1.xhtml" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="plate.xhtml"/><itemref idref="ch1.xhtml"/></spine>
</package>
"""

    with zipfile.ZipFile(out, "w") as archive:
        # `mimetype` first and uncompressed: a reader checks those exact 20
        # bytes at byte 30 before it will look at anything else.
        archive.writestr(
            zipfile.ZipInfo("mimetype", (2026, 10, 5, 0, 0, 0)),
            "application/epub+zip",
            zipfile.ZIP_STORED,
        )
        archive.writestr("META-INF/container.xml", CONTAINER)
        archive.writestr("OEBPS/content.opf", opf)
        archive.writestr("OEBPS/style.css", CSS)
        archive.writestr("OEBPS/nav.xhtml", NAV.format(title=TITLE, items=nav_items))
        archive.writestr("OEBPS/plate.xhtml", PLATE)
        archive.writestr(
            "OEBPS/ch1.xhtml", XHTML.format(title=TITLE, body=body)
        )

    with zipfile.ZipFile(out) as archive:
        spine_bytes = sum(
            item.file_size
            for item in archive.infolist()
            if item.filename.startswith("OEBPS/ch")
        )
    print(
        f"{out}: 2 sections (a plate, then a chapter opener), {spine_bytes / 1024:.1f} kB spine "
        f"(~{spine_bytes // 1500 + 1} pages)"
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/demo/sparse-title.epub")
