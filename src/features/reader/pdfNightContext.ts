/**
 * Night rendering for pdf.js canvases: black paper, light ink, real images.
 *
 * pdf.js converts every colour space (DeviceCMYK, ICCBased, Lab, Separation)
 * to a `#rrggbb` string inside the worker, so a 2D context only ever receives
 * hex strings plus `transparent` and gradient/pattern objects. Rewriting those
 * strings on assignment moves text and vector art onto the paper's bg<->fg
 * axis, while `drawImage` is left alone so photographs keep their colours.
 *
 * Why not pdf.js's own `pageColors`: it is an SVG-filter post pass
 * (`ctx.filter` + redraw of the finished bitmap) that greyscales and
 * quantises images too, and it silently does nothing on WebKit, where
 * `CanvasRenderingContext2D.filter` is undefined.
 */

/** Endpoints of the remapping axis, both plain colours (never gradients). */
export interface NightAxis {
  /** Light end: what black ink becomes. */
  fg: string;
  /** Dark end: what white paper becomes. */
  bg: string;
}

export interface NightOptions extends NightAxis {
  /** Canvas ground colour, assigned to `fillStyle` verbatim. pdf.js paints it
   *  over the whole canvas before anything else; without the bypass it would
   *  be flipped to the light end and the page would come out white. */
  background?: string;
  /** Also invert images. Off by default (images keep their colours); on, a
   *  scanned PDF whose pages are one bright bitmap stops glaring. */
  invertImages?: boolean;
}

/** Darkens the midtones towards the ink end so grey text on dark paper does
 *  not wash out. Below 1 lifts midtones; 1 is a straight luminance swap. */
const GAMMA = 0.85;
/** How much of a colour's original chroma survives. 0 is pure greyscale,
 *  1 leaves coloured headings and charts untouched (and low-contrast). */
const CHROMA_KEEP = 0.35;
/** Images bigger than this on a side skip inversion rather than allocate a
 *  huge scratch canvas; `ponytail:` a page-sized photo is the only real case. */
const MAX_INVERT_EDGE = 4096;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX3 = /^#([\da-f])([\da-f])([\da-f])$/i;
const HEX8 = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i;
const FUNC = /^rgba?\(([^)]+)\)$/i;

const clamp255 = (v: number) => Math.min(255, Math.max(0, v));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const hexByte = (v: number) => Math.round(v).toString(16).padStart(2, "0");
/** Doubles one hex digit: `#abc` expands to `#aabbcc`. */
const hexPair = (s: string) => parseInt(s + s, 16);
/** sRGB channel to linear light, the space luminance is defined in. */
const linear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Parses the colour strings pdf.js can hand to a 2D context. Percentages and
 *  named colours are refused on purpose: they never occur, and passing them
 *  through untouched beats guessing. */
function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value.includes("%")) return null;

  const hex3 = HEX3.exec(value);
  if (hex3) {
    return { r: hexPair(hex3[1]!), g: hexPair(hex3[2]!), b: hexPair(hex3[3]!), a: 1 };
  }
  const hex8 = HEX8.exec(value);
  if (hex8) {
    return {
      r: parseInt(hex8[1]!, 16),
      g: parseInt(hex8[2]!, 16),
      b: parseInt(hex8[3]!, 16),
      a: hex8[4] === undefined ? 1 : parseInt(hex8[4]!, 16) / 255,
    };
  }
  const fn = FUNC.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const alpha = parts[3] === undefined ? 1 : clamp01(Number(parts[3]));
      if (Number.isNaN(alpha)) return null;
      return {
        r: clamp255(Number(parts[0])),
        g: clamp255(Number(parts[1])),
        b: clamp255(Number(parts[2])),
        a: alpha,
      };
    }
  }
  return null;
}

function toCss({ r, g, b, a }: Rgba): string {
  return a >= 1
    ? `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
    : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

function linearLuma({ r, g, b }: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Maps one colour onto the bg<->fg axis: dark ink goes to `fg`, white paper
 *  to `bg`, and a share of the original chroma rides along so a red heading
 *  stays red instead of turning cyan. Unparseable input (gradients, patterns)
 *  is returned untouched. */
export function remapColor(color: string, axis: NightAxis): string {
  const c = parseColor(color);
  if (!c || c.a === 0) return color;
  const fg = parseColor(axis.fg);
  const bg = parseColor(axis.bg);
  if (!fg || !bg) return color;

  const t = linearLuma(c) ** GAMMA;
  const gray = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const onAxis = (from: number, to: number) => from + (to - from) * t;
  return toCss({
    r: clamp255(onAxis(fg.r, bg.r) + (c.r - gray) * CHROMA_KEEP),
    g: clamp255(onAxis(fg.g, bg.g) + (c.g - gray) * CHROMA_KEEP),
    b: clamp255(onAxis(fg.b, bg.b) + (c.b - gray) * CHROMA_KEEP),
    a: c.a,
  });
}

/** A context that behaves like `ctx` but recolours everything pdf.js draws
 *  except images. Only the instance handed to `page.render` is wrapped, so
 *  other canvases (the shelf's cover render) keep their real colours. */
export function wrapNightContext(
  ctx: CanvasRenderingContext2D,
  opts: NightOptions,
): CanvasRenderingContext2D {
  const axis: NightAxis = { fg: opts.fg, bg: opts.bg };
  // pdf.js touches the context ~10^5 times per page, so bound methods are
  // memoised; a fresh `bind` per get would dominate the render.
  const bound = new Map<string | symbol, unknown>();
  let scratch: HTMLCanvasElement | null = null;

  const remapGradient = (gradient: CanvasGradient): CanvasGradient =>
    new Proxy(gradient, {
      get(gradientTarget, prop) {
        if (prop === "addColorStop") {
          return (offset: number, color: string) =>
            gradientTarget.addColorStop(offset, remapColor(color, axis));
        }
        const value = Reflect.get(gradientTarget, prop, gradientTarget);
        return typeof value === "function" ? value.bind(gradientTarget) : value;
      },
    });

  const invertImage = (image: CanvasImageSource, args: number[]): boolean => {
    // arg forms: (img,dx,dy) | (img,dx,dy,dw,dh) | (img,sx,sy,sw,sh,dx,dy,dw,dh)
    const dest = args.length >= 9 ? args.slice(5) : args;
    const [dx, dy] = dest as [number, number];
    const dw = dest.length >= 4 ? dest[2]! : sourceWidth(image);
    const dh = dest.length >= 4 ? dest[3]! : sourceHeight(image);
    const w = Math.min(Math.round(dw), MAX_INVERT_EDGE);
    const h = Math.min(Math.round(dh), MAX_INVERT_EDGE);
    if (!(w > 0 && h > 0)) return false;

    scratch ??= document.createElement("canvas");
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) return false;
    sctx.clearRect(0, 0, w, h);
    if (args.length >= 9) {
      sctx.drawImage(image, args[0]!, args[1]!, args[2]!, args[3]!, 0, 0, w, h);
    } else {
      sctx.drawImage(image, 0, 0, w, h);
    }
    // No `ctx.filter` on WebKit, so invert the scratch with a difference pass.
    sctx.globalCompositeOperation = "difference";
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, w, h);
    sctx.globalCompositeOperation = "source-over";
    ctx.drawImage(scratch, dx, dy, w, h);
    return true;
  };

  const linearGradient = (x0: number, y0: number, x1: number, y1: number) =>
    remapGradient(ctx.createLinearGradient(x0, y0, x1, y1));
  const radial = (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) =>
    remapGradient(ctx.createRadialGradient(x0, y0, r0, x1, y1, r1));
  const conic = (startAngle: number, x: number, y: number) =>
    remapGradient(ctx.createConicGradient(startAngle, x, y));
  const draw = (image: CanvasImageSource, ...args: number[]) => {
    if (!invertImage(image, args)) {
      (ctx.drawImage as (...a: unknown[]) => void).call(ctx, image, ...args);
    }
  };

  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "createLinearGradient") return linearGradient;
      if (prop === "createRadialGradient") return radial;
      if (prop === "createConicGradient") return conic;
      if (prop === "drawImage" && opts.invertImages) return draw;
      const cached = bound.get(prop);
      if (cached !== undefined) return cached;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value.bind(target);
      bound.set(prop, fn);
      return fn;
    },
    set(target, prop, value) {
      if ((prop === "fillStyle" || prop === "strokeStyle") && typeof value === "string") {
        target[prop] = value === opts.background ? value : remapColor(value, axis);
        return true;
      }
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  });
}

/** Installs the night wrapper on one canvas element; the returned function
 *  undoes it. pdf.js v6 discards a handed-in `canvasContext` as soon as
 *  `canvas` is set (`this._canvasContext = params.canvas ? null : params.canvasContext`)
 *  and calls `canvas.getContext("2d")` itself, so the element is the only
 *  stable hook that survives into the render. */
export function installNightContext(
  canvas: HTMLCanvasElement,
  fg: string,
  bg: string,
  invertImages = false,
): () => void {
  const original = canvas.getContext.bind(canvas);
  let wrapped: CanvasRenderingContext2D | null = null;
  canvas.getContext = ((id: string, options?: CanvasRenderingContext2DSettings) => {
    if (id !== "2d") return original(id, options);
    const raw = original(id, options);
    if (!raw) return null;
    wrapped ??= wrapNightContext(raw as CanvasRenderingContext2D, {
      fg,
      bg,
      background: bg,
      invertImages,
    });
    return wrapped;
  }) as HTMLCanvasElement["getContext"];
  return () => {
    canvas.getContext = original as HTMLCanvasElement["getContext"];
  };
}

function sourceWidth(image: CanvasImageSource): number {
  return "width" in image ? Number(image.width) : 0;
}

function sourceHeight(image: CanvasImageSource): number {
  return "height" in image ? Number(image.height) : 0;
}
