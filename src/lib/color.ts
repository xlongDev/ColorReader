/**
 * Hex ↔ HSV, for the colour pickers that live inside a settings row.
 *
 * HSV is the space a picker works in — one square for saturation and value, one
 * rail for hue — while a hex string is what the rest of the app stores. The two
 * conversions round-trip on 8-bit channels, which is what lets a picker compare
 * "the colour I would draw" against "the colour I was handed" and tell an
 * outside change from its own.
 */

export interface Hsv {
  /** Degrees, 0–360. Grey and black carry no hue of their own, so this is 0. */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1. */
  v: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The six channels of `#rgb` or `#rrggbb`, or `null` if it is neither. */
function channels(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "").toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
  const full = value.length === 3 ? [...value].map((digit) => digit + digit).join("") : value;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function hexToHsv(hex: string): Hsv {
  const rgb = channels(hex);
  if (!rgb) return { h: 0, s: 0, v: 0 };
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let h = 0;
  if (span > 0) {
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : span / max, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const saturation = clamp01(s);
  const value = clamp01(v);
  const chroma = value * saturation;
  const turn = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((turn % 2) - 1));
  const [r, g, b] =
    turn < 1
      ? [chroma, second, 0]
      : turn < 2
        ? [second, chroma, 0]
        : turn < 3
          ? [0, chroma, second]
          : turn < 4
            ? [0, second, chroma]
            : turn < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const base = value - chroma;
  const to = (n: number) =>
    Math.round((n + base) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
