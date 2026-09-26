#!/usr/bin/env python3
"""Regenerate `e2e/fixtures/images.epub`.

Why this exists: nothing in the suite ever opened the image lightbox. The
desktop's `book_images` reads a book-wide list out of the chapter text it
already stores, and the browser's comes from a walk done at import — but the
lightbox itself, and the index it opens at, were only ever checked by reading.
So the defect this fixture pins went unseen: in the browser, clicking the third
picture of a book opened the *first*, because the click registered the picture
in a one-entry list while the viewer rendered the book's own list.

    python3 scripts/generate-images-fixture.py e2e/fixtures/images.epub

Three pictures in the first chapter, on purpose, in a known order:

- **three**, so an off-by-a-list index is visible. With one picture, "the one I
  clicked" and "the first one" are the same answer.
- **different sizes**, so the picture on screen identifies which one it is
  without reading the counter — the assertion can name a picture rather than
  trust the number it is checking.
- **in the first chapter**, so the spec reaches them without paging.

A second chapter of text follows, so the book is a book: the reader has
somewhere to go and the lightbox's chapter label has something to be right or
wrong about.
"""

import struct
import sys
import zipfile
import zlib

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

PROSE = (
    "这一段文字只是为了把图片隔开，让每一张图都落在自己的段落里，"
    "点开的时候不会三张挤在同一行上。"
)

# The first chapter is deliberately short. Its three pictures have to be on the
# page the book opens on: a spec clicks the third, and a picture laid out on a
# column the paginator has scrolled past is one the click cannot reach — which
# showed up as a test that passed or failed depending on how the text measured.
CHAPTER_ONE = ["三张图，按顺序排在同一页上。"]

# (file, width, height, colour). The sizes differ so the picture on screen says
# which one it is; the colour says it again for a reader looking at the trace.
IMAGES = [
    ("fig1.png", 160, 120, (196, 74, 74)),
    ("fig2.png", 120, 160, (74, 150, 96)),
    ("fig3.png", 200, 100, (74, 106, 196)),
]


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-colour PNG, built by hand: no image library for three rectangles."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    # One filter byte (0 = none) per scanline, then the pixels.
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main(out: str) -> None:
    body = [f"<p>{line}</p>" for line in CHAPTER_ONE]
    for name, width, height, _ in IMAGES:
        # Intrinsic size only: a reflowable EPUB scales to the column, and the
        # click handler ignores anything rendered under 48px.
        body.append(f'<p><img src="images/{name}" alt="{name}" width="{width}" height="{height}"/></p>')

    manifest = [
        f'<item id="{name}" href="images/{name}" media-type="image/png"/>'
        for name, _, _, _ in IMAGES
    ]
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:colorreader-images</dc:identifier>
    <dc:title>图片样书</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-09-26T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    {chr(10).join("    " + item for item in manifest)}
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

    with zipfile.ZipFile(out, "w") as archive:
        # `mimetype` first and stored: a reader checks those exact bytes before
        # it will look at anything else.
        archive.writestr(
            zipfile.ZipInfo("mimetype", (2026, 9, 26, 0, 0, 0)),
            "application/epub+zip",
            zipfile.ZIP_STORED,
        )
        archive.writestr("META-INF/container.xml", CONTAINER)
        archive.writestr("OEBPS/content.opf", opf)
        archive.writestr(
            "OEBPS/nav.xhtml",
            NAV.format(
                items='<li><a href="ch1.xhtml">第一章 三张图</a></li>'
                '<li><a href="ch2.xhtml">第二章 只有字</a></li>'
            ),
        )
        archive.writestr(
            "OEBPS/ch1.xhtml",
            XHTML.format(title="第一章 三张图", body="\n".join(body)),
        )
        archive.writestr(
            "OEBPS/ch2.xhtml",
            XHTML.format(
                title="第二章 只有字",
                body="".join(f"<p>{PROSE}</p>" for _ in range(12)),
            ),
        )
        for name, width, height, rgb in IMAGES:
            archive.writestr(f"OEBPS/images/{name}", png(width, height, rgb))

    print(f"wrote {out} ({len(IMAGES)} images, 2 chapters)")


if __name__ == "__main__":
    main(sys.argv[1])
