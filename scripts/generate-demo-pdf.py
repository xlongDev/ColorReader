#!/usr/bin/env python3
"""Regenerate `public/demo/pdf-pages.pdf`.

Why this exists: the browser fixture (`src/lib/demo.ts`) has no PDF, so
`pnpm test:e2e` has never opened one. Everything a PDF page does — rasterising
into a canvas, building a selectable text layer, the offscreen double buffer
that keeps the old page up, the prefetch that makes the next turn a blit — was
verified by reading alone. Two real defects landed in exactly that gap in one
evening (a page turn that flashed white, and a sidebar spring that re-rasterised
every page on screen once per frame).

    python3 scripts/generate-demo-pdf.py public/demo/pdf-pages.pdf

The fixture is deliberately **not uniform**: five ordinary text pages against a
sixth that is a dense vector grid, slow enough that a turn onto it is visible to
the eye. No assertion in the suite measures that — the prefetch is asserted by
what it blits, not by how long it took — but a reader checking the fix by hand
needs one page where a warm turn and a cold one look different.

Latin text on purpose: the base-14 fonts carry no CJK, and embedding a subset
would mean shipping a font parser to generate a fixture. The reader does not
care what the glyphs say.
"""

import sys
import zlib

PAGES = 6
WIDTH, HEIGHT = 420.0, 595.0
HEAVY_PAGE = 6
# One page carries a colour image. Night mode reads the paper at the top-left
# corner, so the patch sits low on the page where nothing else is drawn.
IMAGE_PAGE = 1
IMAGE_X, IMAGE_Y = 40.0, 90.0
IMAGE_W, IMAGE_H = 120.0, 80.0
# A warm orange: red leads green leads blue by a wide margin.
IMAGE_RGB = (240, 200, 170)

BODY = [
    "A fixed-layout document is drawn, not laid out: the page arrives with its",
    "own fonts, its own spacing and its own illustrations already composed, and",
    "the reader's job is to put those pixels on the screen unchanged.",
    "",
    "That is the whole contract, and it is why this path renders through a",
    "canvas instead of extracting text. Anything the reader does to a PDF page",
    "has to happen around the bitmap, never to it.",
    "",
    "Which makes the cost of a page turn a rendering cost, and rendering is",
    "slow enough to see: a page like this one takes tens of milliseconds, and a",
    "page dense with vector work takes a good deal more. Whatever the reader is",
    "looking at during that time is what they will remember about the turn.",
    "",
    "Hence the double buffer. The page already on screen stays there until its",
    "replacement exists, and the swap between them happens inside a single",
    "task so the browser never paints the gap.",
]


def body_ops(offset: int) -> list[str]:
    """The paragraphs, rotated by `offset` so no two pages read alike."""
    lines = BODY[offset:] + BODY[:offset]
    ops = ["BT", "/F1 9 Tf", f"40 {HEIGHT - 130:.0f} Td", "13 TL"]
    for line in lines:
        # Parentheses and backslashes are the only characters that need
        # escaping in a PDF literal string, and the fixture contains neither.
        ops.append(f"({line}) Tj T*" if line else "T*")
    ops.append("ET")
    return ops


def heavy_ops() -> list[str]:
    """A dense grid of small filled rectangles — cheap to write, dear to draw."""
    ops = ["0.16 0.22 0.38 rg"]
    for column in range(46):
        for row in range(42):
            x = 22 + column * 8.3
            y = 44 + row * 7.6
            ops.append(f"{x:.1f} {y:.1f} 6.6 6.0 re f")
    ops.append("1 1 1 rg")
    ops.append("0.5 0.5 0.5 RG 0.6 w")
    for i in range(18):
        y = 60 + i * 15
        ops.append(f"22 {y} 376 {y + 0.2:.1f} re S")
    return ops


def page_stream(index: int) -> str:
    ops = [
        "BT",
        "/F1 20 Tf",
        f"40 {HEIGHT - 78:.0f} Td",
        f"(Page {index}) Tj",
        "ET",
    ]
    ops += body_ops((index - 1) * 3)
    if index == IMAGE_PAGE:
        ops.append(image_ops())
    if index == HEAVY_PAGE:
        ops += heavy_ops()
    return "\n".join(ops) + "\n"


def image_ops() -> str:
    """Places the colour swatch.

    A warm, saturated patch: the whole point of it is that a per-channel
    inversion turns it cyan, so a reader can tell the two image modes apart by
    eye, and a test can tell them apart by whether red still leads blue.
    """
    return f"q {IMAGE_W} 0 0 {IMAGE_H} {IMAGE_X} {IMAGE_Y} cm /Im1 Do Q"


def build() -> bytes:
    objects: list[bytes] = []
    # 1 catalog, 2 pages, 3..3+PAGES-1 page dicts, then the streams, then font.
    # 1 catalog, 2 pages, 3..8 page dicts, 9..14 streams, 15 font, 16 image.
    first_page, first_stream = 3, 3 + PAGES
    font_id = first_stream + PAGES
    image_id = font_id + 1

    kids = " ".join(f"{first_page + i} 0 R" for i in range(PAGES))
    objects.append(f"<< /Type /Catalog /Pages 2 0 R >>".encode())
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {PAGES} >>".encode())

    for i in range(PAGES):
        stream_id = first_stream + i
        resources = f"/Font << /F1 {font_id} 0 R >>"
        if i + 1 == IMAGE_PAGE:
            resources += f" /XObject << /Im1 {image_id} 0 R >>"
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R "
                f"/MediaBox [0 0 {WIDTH:.0f} {HEIGHT:.0f}] "
                f"/Resources << {resources} >> "
                f"/Contents {stream_id} 0 R >>"
            ).encode()
        )

    for i in range(PAGES):
        stream = page_stream(i + 1).encode("ascii")
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")

    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    # A 2x2 patch of one colour, stretched by the `cm` in `image_ops`. Solid on
    # purpose: the image is there to be sampled, not to look like anything.
    pixels = bytes(IMAGE_RGB) * 4
    raw = zlib.compress(pixels)
    objects.append(
        (
            f"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
            f"/Length {len(raw)} >>"
        ).encode()
        + b"\nstream\n"
        + raw
        + b"\nendstream"
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size "
        + str(len(objects) + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref).encode()
        + b"\n%%EOF\n"
    )
    return bytes(out)


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else "public/demo/pdf-pages.pdf"
    data = build()
    with open(target, "wb") as handle:
        handle.write(data)
    print(f"wrote {target} ({len(data)} bytes, {PAGES} pages)")


if __name__ == "__main__":
    main()
