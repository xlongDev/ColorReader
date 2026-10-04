#!/usr/bin/env python3
"""Generate ColorReader application icons (PNG / ICNS / ICO).

Dependency free on purpose: the repo must not need Pillow or a headless
browser just to regenerate branding assets.

    python3 scripts/generate-icons.py

Writes into src-tauri/icons/ :
    32x32.png  128x128.png  128x128@2x.png  icon.png(1024)
    icon.icns  icon.ico
    trayTemplate.png (44px, menu bar)

The tray image is the same five reading lines reduced to a mask: macOS paints a
template image in its own menu-bar colour, so only the shape and the alpha
survive and the palette above is deliberately unused.
"""

from __future__ import annotations

import os
import shutil
import struct
import subprocess
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "src-tauri", "icons")
WORK = os.path.join(ROOT, "target", "iconset")

SIZE = 1024
SS = 3  # supersample factor, 3x3 -> 9 alpha levels on edges

# Graphite shell with a vertical gradient.
BG_TOP = (0x17, 0x1B, 0x22)
BG_BOTTOM = (0x0B, 0x0D, 0x11)

# Five reading lines in a muted spectrum: the "color" in ColorReader.
BARS = [
    (0xF0, 0xA9, 0x3B),  # amber
    (0xE0, 0x73, 0x5C),  # coral
    (0xB0, 0x67, 0x9B),  # plum
    (0x5C, 0x7F, 0xBF),  # steel blue
    (0x4F, 0xA8, 0x9B),  # teal
]

N = SIZE * SS
CENTER = N / 2.0
RADIUS = N / 2.0
SQUIRCLE_N = 5.0
INNER_RADIUS = RADIUS - 4.0 * SS  # inner highlight ring width


def build_pixel_arrays() -> tuple[list[float], list[float]]:
    """|dx/a|^n tables for the outer shape and the inner highlight ring."""
    outer = [0.0] * N
    inner = [0.0] * N
    for i in range(N):
        d = abs(i + 0.5 - CENTER)
        outer[i] = (d / RADIUS) ** SQUIRCLE_N
        inner[i] = (d / INNER_RADIUS) ** SQUIRCLE_N
    return outer, inner


def render() -> bytearray:
    outer, inner = build_pixel_arrays()

    bar_h = 0.082 * N
    bar_gap = 0.052 * N
    glyph_h = len(BARS) * bar_h + (len(BARS) - 1) * bar_gap
    top = CENTER - glyph_h / 2.0
    full_w = 0.60 * N
    short_w = 0.34 * N
    left = CENTER - full_w / 2.0

    bars = []
    for idx, color in enumerate(BARS):
        y0 = top + idx * (bar_h + bar_gap)
        y1 = y0 + bar_h
        width = short_w if idx == len(BARS) - 1 else full_w
        bars.append((y0, y1, left, left + width, color, bar_h / 2.0))

    buf = bytearray(N * N * 4)
    for y in range(N):
        row = y * N * 4
        dy_out = (abs(y + 0.5 - CENTER) / RADIUS) ** SQUIRCLE_N
        dy_in = (abs(y + 0.5 - CENTER) / INNER_RADIUS) ** SQUIRCLE_N
        t = y / (N - 1)
        bg = (
            BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
            BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
            BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
        )
        # Bars never overlap vertically, so a row touches at most one of them.
        py = y + 0.5
        active = next(
            (bar for bar in bars if bar[0] <= py <= bar[1]),
            None,
        )
        for x in range(N):
            if outer[x] + dy_out > 1.0:
                continue

            r, g, b = bg
            if outer[x] + dy_out > 0.90 or inner[x] + dy_in > 1.0:
                # Rim light along the squircle edge.
                r, g, b = (r + (255 - r) * 0.22, g + (255 - g) * 0.22, b + (255 - b) * 0.22)

            if active is not None:
                _y0, _y1, x0, x1, color, rr = active
                if x0 <= x <= x1:
                    # Pill: clamp the sampling point to the core segment.
                    cx = min(max(x + 0.5, x0 + rr), x1 - rr)
                    cy = min(max(py, _y0 + rr), _y1 - rr)
                    if (x + 0.5 - cx) ** 2 + (py - cy) ** 2 <= rr * rr:
                        r, g, b = color

            i = row + x * 4
            buf[i] = int(round(r))
            buf[i + 1] = int(round(g))
            buf[i + 2] = int(round(b))
            buf[i + 3] = 255
    return buf


def downsample(buf: bytearray, size: int = SIZE, ss: int = SS) -> bytes:
    """Average SSxSS blocks and premultiply-free alpha back into RGBA."""
    out = bytearray(size * size * 4)
    area = ss * ss
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                base = ((y * ss + sy) * size * ss + x * ss) * 4
                for sx in range(ss):
                    i = base + sx * 4
                    alpha = buf[i + 3]
                    r += buf[i] * alpha
                    g += buf[i + 1] * alpha
                    b += buf[i + 2] * alpha
                    a += alpha
            o = (y * size + x) * 4
            if a == 0:
                continue
            out[o] = r // a
            out[o + 1] = g // a
            out[o + 2] = b // a
            out[o + 3] = (a + area // 2) // area
    return bytes(out)


def write_png(path: str, size: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type: none
        raw += rgba[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def resize(src: str, dst: str, size: int) -> None:
    subprocess.run(
        ["sips", "-z", str(size), str(size), src, "--out", dst],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def build_icns(master: str, iconset: str, dst: str) -> None:
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    for pt in (16, 32, 128, 256, 512):
        resize(master, os.path.join(iconset, f"icon_{pt}x{pt}.png"), pt)
        resize(master, os.path.join(iconset, f"icon_{pt // 2}x{pt // 2}@2x.png"), pt)
    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", dst],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    shutil.rmtree(iconset, ignore_errors=True)


def build_ico(master: str, dst: str) -> None:
    entries: list[tuple[int, bytes]] = []
    tmp = os.path.join(WORK, "ico")
    os.makedirs(tmp, exist_ok=True)
    for size in (16, 24, 32, 48, 64, 128, 256):
        path = os.path.join(tmp, f"{size}.png")
        resize(master, path, size)
        with open(path, "rb") as fh:
            entries.append((size, fh.read()))
    shutil.rmtree(tmp, ignore_errors=True)

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b""
    blob = b""
    for size, data in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blob += data
    with open(dst, "wb") as fh:
        fh.write(header + directory + blob)


TRAY = 44  # menu-bar template, square: macOS scales it to 18pt by height
TRAY_SS = 8
TRAY_BAR_H = 4.5
TRAY_GAP = 2.5
TRAY_W = 34.0
TRAY_SHORT = 19.0


def render_tray() -> bytearray:
    """The five reading lines as an alpha mask: black on nothing.

    macOS paints a template image in its own menu-bar colour, so the spectrum
    above is gone by the time this is on screen — the shape is the whole icon,
    and the alpha is what carries it.
    """
    n = TRAY * TRAY_SS
    s = float(TRAY_SS)
    count = len(BARS)
    bar_h = TRAY_BAR_H * s
    gap = TRAY_GAP * s
    glyph_h = count * bar_h + (count - 1) * gap
    top = (n - glyph_h) / 2.0
    full_w = TRAY_W * s
    left = (n - full_w) / 2.0
    radius = bar_h / 2.0

    pills = []
    for idx in range(count):
        y0 = top + idx * (bar_h + gap)
        width = TRAY_SHORT * s if idx == count - 1 else full_w
        pills.append((y0, y0 + bar_h, left, left + width))

    buf = bytearray(n * n * 4)
    for y in range(n):
        py = y + 0.5
        active = next((pill for pill in pills if pill[0] <= py <= pill[1]), None)
        if active is None:
            continue
        y0, y1, x0, x1 = active
        row = y * n * 4
        for x in range(n):
            px = x + 0.5
            if not x0 <= px <= x1:
                continue
            # Pill: clamp the sampling point to the core segment.
            cx = min(max(px, x0 + radius), x1 - radius)
            cy = min(max(py, y0 + radius), y1 - radius)
            if (px - cx) ** 2 + (py - cy) ** 2 > radius * radius:
                continue
            buf[row + x * 4 + 3] = 255
    return buf


def build_tray() -> None:
    """Writes the menu-bar template the tray icon is loaded from."""
    path = os.path.join(ICONS, "trayTemplate.png")
    write_png(path, TRAY, downsample(render_tray(), TRAY, TRAY_SS))
    print(f"  trayTemplate.png ({TRAY}px)")


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)

    print("rendering 1024px master (supersampled 3x) ...")
    master = os.path.join(WORK, "master.png")
    write_png(master, SIZE, downsample(render()))

    targets = {
        "icon.png": SIZE,
        "128x128@2x.png": 256,
        "128x128.png": 128,
        "32x32.png": 32,
    }
    for name, size in targets.items():
        path = os.path.join(ICONS, name)
        if size == SIZE:
            shutil.copyfile(master, path)
        else:
            resize(master, path, size)
        print(f"  {name} ({size}px)")

    build_icns(master, os.path.join(WORK, "icon.iconset"), os.path.join(ICONS, "icon.icns"))
    print("  icon.icns")
    build_ico(master, os.path.join(ICONS, "icon.ico"))
    print("  icon.ico")

    build_tray()

    assert os.path.getsize(os.path.join(ICONS, "icon.icns")) > 0
    assert os.path.getsize(os.path.join(ICONS, "trayTemplate.png")) > 0
    print("done ->", os.path.relpath(ICONS, ROOT))


if __name__ == "__main__":
    main()
