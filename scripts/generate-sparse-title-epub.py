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

# Each paragraph has to run to **several** lines, not two. Two reasons, both
# measured:
#
# - The padding regression reads a block of `rulerLines` lines and asks how far
#   the band stands off it. With a two-line paragraph the block *is* the
#   paragraph, its extent already includes the `0.78em` gap, and the padding is a
#   rounding error beside it — the slot went green with the guard removed.
# - A 1.2 leading on 18px type is 21.6px a line, so a paragraph needs three or
#   more of them before the gap between paragraphs (≈33px) is unambiguously
#   *not* the leading. Two lines and the median step across the page is the gap.
PARAGRAPHS = [
    "一九三〇年代的某个下午，我在.library 的窗边读到一封很旧的信，信里说人这一生会失去很多东西，"
    "但真正失去的只有一样，就是妄自尊大。那封信的字迹已经褪得很淡，纸边也卷了起来，"
    "可每一句都还认得出来，我把它抄在本子上，抄完就放在窗台上，此后多年没有动过。",
    "那封信没有署名，年份也不清楚，可我后来反复想起它，大概是因为它说中了一件我花了很久"
    "才肯承认的事。承认之后，剩下的事情就简单了：把「我知道」换成「我不知道」，"
    "然后把剩下的时间用来把不知道变成知道——这条路上没有捷径，但每一步都算数。",
    "这也是这本书想说的全部内容——不是结论，是方法。书里那些看起来绕远的讨论，"
    "其实都在回答同一个问题：我们凭什么以为自己知道的事情，比实际知道的更多。"
    "把这件事想清楚，后面读什么都会轻一点。",
]

# A third section, one short paragraph, on purpose. In 竖排 a paragraph is a
# column, so a short paragraph is a **short column** — and that is the shape a
# band's *height* has to be able to describe. Measured on a real book
# (《认识世界》, 18px 竖排) the ruler drew every band the full 636px of the reading
# area, overhanging the words below by 269–418px, because it read the page's
# height as the band's instead of the column's.
#
# Its own section rather than a paragraph at the end of the opener's, because the
# opener's pagination is itself under test (a title centred in three-quarters of a
# blank page, with the first paragraph hundreds of pixels below it) and one more
# paragraph there changed how that page breaks. And a whole section of one line is
# the honest shape anyway: every chapter's last page in a real book is a page of
# a few lines, not a full one.
SHORT_SECTION_TITLE = "尾"
# One long paragraph between short ones: the shape that **tells two bugs apart**.
# In 竖排 a paragraph is a run of columns, so a multi-line paragraph is a run of
# full-height ones and a one-line paragraph is a single short column — and those
# two have to sit side by side on the page. Measured on a real book (《认识世界》,
# 18px 竖排): the band stood on a short column, and the fragment filter let the
# column beside it in because the band *clipped* it — 2px of its 25 — and that
# neighbour ran 318px down the page while the words under the band stopped at
# 226px. 「带子压着它」和「带子擦到它」是两回事，可只要有一点重叠就会被算进去。
#
# Short enough that a band drawn at the page's height cannot pass for one that
# fits them, and enough of them that the slot can measure a band over more than
# one (one column would leave "the band covers the columns it marks" and "the band
# covers everything" as the same claim).
SHORT_SECTION_BODY = [
    "就到这里吧。",
    "后面没有了。",
    "这一章写到最后只剩下几行，可它们该说的都说完了：纸有两端，翻过去是空白，"
    "翻回来还是空白，中间夹着的这一段才是全部。写的人知道会在哪里停下，读的人"
    "要走到最后一行才知道，而两个人看见的是同一片空白，这大概就是一本书的全部。",
    "剩下的只有空白。",
]

# The shape under test: a title centred in most of the page, the text far below
# it. `min-height` on a flex column with `justify-content: center` is how real
# books write a chapter opener, and it is what puts hundreds of pixels of nothing
# between the two lines the ruler has to choose between.
#
# The line height is the second shape, and the one that decides whether this
# fixture can tell anything: 使用书籍排版 hands the book its own paragraph styles
# back, so the page's leading is whatever is written here. The reader's presets
# are 1.6 / 1.8 / 2.0 / 2.2 — at 18px that is 28.8 / 32.4 / 36 / 39.6px a line.
# This book was originally 1.75, which is 31.5px: **0.9px away from the 1.8
# preset**, so a ruler padding off the setting and a ruler padding off the page
# were indistinguishable and the regression slot was decoration. It has to be
# nowhere near a preset. 1.2 is the shape found on the real book that reported
# it (《认识世界》, whose sections advance 21.6px at 18px) and it clears the
# nearest preset by 7px.
CSS = """@charset "utf-8";
body { font-family: "Noto Serif CJK SC", "Songti SC", serif; line-height: 1.2;
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
{opening}
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
        f'<li><a href="ch2.xhtml">{SHORT_SECTION_TITLE}</a></li>'
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
    <item id="ch2.xhtml" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="plate.xhtml"/><itemref idref="ch1.xhtml"/><itemref idref="ch2.xhtml"/></spine>
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
            "OEBPS/ch1.xhtml",
            XHTML.format(
                title=TITLE,
                body=body,
                opening=f'<section class="chapter-title"><h1>{TITLE}</h1></section>',
            ),
        )
        # No `.chapter-title` here: this section is the short-column shape, and a
        # title centred in three-quarters of a blank page would put a full-height
        # line on it and hide the very column the slot is here to measure.
        archive.writestr(
            "OEBPS/ch2.xhtml",
            XHTML.format(
                title=SHORT_SECTION_TITLE,
                body="\n".join(f"<p>{line}</p>" for line in SHORT_SECTION_BODY),
                # No opening section: a title centred in three-quarters of a blank
                # page would put a full-height line on this page and hide the very
                # short column the slot is here to measure.
                opening="",
            ),
        )

    with zipfile.ZipFile(out) as archive:
        spine_bytes = sum(
            item.file_size
            for item in archive.infolist()
            if item.filename.startswith("OEBPS/ch")
        )
    print(
        f"{out}: 3 sections (a plate, a chapter opener, a short one), "
        f"{spine_bytes / 1024:.1f} kB spine (~{spine_bytes // 1500 + 1} pages)"
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/demo/sparse-title.epub")
