/**
 * The stylesheet injected into every foliate section document.
 *
 * Its own module because it is the one place where the reading settings meet
 * a book's own CSS, and because the rules are worth probing in isolation (a
 * WebKit fixture loads this exact string).
 */

/** Typography and palette pushed into the book's own document. */
export type FoliateStyle = {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  /** Paragraph gap in em, mirroring the prose path's per-`p` margin. */
  paraGap: number;
  /** Two-em first-line indent on every paragraph. */
  indent: boolean;
  fg: string;
  bg: string;
  dark: boolean;
  /** Invert the book's own images on a night page. Off by default: the
   *  palette already makes the page dark, and an inverted photograph is a
   *  defect rather than a feature. */
  invertImages: boolean;
};

/**
 * Typography always. Colour follows the readest scheme and is dark-only:
 * the paginator lifts each section's wallpaper out of the document at load
 * time by reading the computed body background, and falls back to the html
 * background only when body is fully transparent (paginator.js
 * `getBackground`) — so html/body never get a background from us. Instead we
 * publish `--theme-bg-color` on `html`: the paginator's `#background` layer
 * paints it as the page fill for transparent sections, and its resolver swaps
 * the colour component of every section's own background (keeping wallpaper
 * images) for the theme colour. Text is recoloured with the same rules
 * readest ships in `getColorStyles`, minus the element-level repaints we
 * don't expose yet.
 *
 * `color-scheme` must stay untouched anywhere in this chain — neither here
 * nor as a `<meta name="color-scheme">` in index.html: once a frame's used
 * colour scheme resolves away from `normal`, WebKit paints the iframe's
 * transparent-root canvas OPAQUE (dark under `dark`, white otherwise), which
 * sits on top of and completely hides the `#background` layer — the wallpaper
 * vanishes and page fill falls back to the system colour. `--override-color:
 * true` drives the same resolver colour swap without touching the canvas, and
 * the paginator's resolver keeps every image-bearing background (Kindle paper
 * textures) in its original colours, swapping only imageless page fills for
 * the theme colour.
 */
export const buildStyleSheet = ({
  fontSize,
  fontFamily,
  lineHeight,
  paraGap,
  indent,
  fg,
  bg,
  dark,
  invertImages,
}: FoliateStyle) => {
  const typography = `:root {
  /* The system stack resolves to var(--font-sans) from the app shell,
     which does not exist inside a book iframe — define it here. */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
html, body {
  /* !important: KF8 books ship their own body typography for print paper;
     the reader settings win over the book. */
  font-size: ${fontSize}px !important;
}
/* A Kindle book restates line-height, font-family, margins and text-indent on
   every paragraph class it ships, so html/body alone never reaches the
   text — measured on a KF8 file: body computed line-height followed the
   setting while every p kept the book's own 1.8. Repeat the settings on the
   text elements themselves. Font SIZE deliberately stays on html/body only:
   the book's em-based sizes scale with it, which keeps its headings and
   title pages at the proportions its designer chose.
   div is included because Calibre/KF8 mobi often wrap body paragraphs in
   div.calibre_2 instead of p — without it the three typography
   settings silently do nothing on those books (see probe on b3.mobi). */
html, body, p, li, blockquote, dd, dt, td, th, div {
  font-family: ${fontFamily} !important;
  line-height: ${lineHeight} !important;
}
/* Both sides of the gap, not just the bottom: these books set a large
   margin-top on their paragraph classes (27–63px measured), which swamped
   a bottom-only override and made 紧凑 and 标准 look identical.
   Paragraph <div>s get the same gap. The :has() guard keeps structural
   container divs (those holding block children) out of the rule so we do
   not inflate spacing around layout boxes; it is kept in its own rule so
   that on a WebView without :has() support only this div clause is dropped,
   not the p/li clause above. */
p, li, blockquote, dd {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
div:not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6)) {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
/* Off must be as loud as on: the book's own 2em indent survives an omitted
   declaration, so the toggle only reads as broken when it is not forced.
   Same div handling as the gap above. */
p {
  text-indent: ${indent ? "2em" : "0"} !important;
}
div:not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6)) {
  text-indent: ${indent ? "2em" : "0"} !important;
}
/* Replaced elements are the one thing a book cannot be trusted to size: a
   cover or a plate authored for print paper is routinely wider than the
   column, and the paginator only caps a replaced element against its own
   parent (setImageSize writes max-width: 100% of that parent), which is not
   the column when the book wrapped it in a print-width box. Cap the box,
   keep the ratio. */
img, svg, video, canvas, image {
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain;
}
/* Same reason for a wrapper the book fixed to print width: the page has to
   fit the column, not the other way round. Only an explicit pixel width is
   clamped — percentages and fr units already resolve against the column. */
*[width]:not([width=""]):not([width*="%"]) {
  max-width: 100% !important;
}`;
  if (!dark) return typography;
  return `${typography}
html {
  --bg-texture-id: none;
  --theme-bg-color: ${bg};
  --theme-fg-color: ${fg};
  --override-color: true;
}
html, body {
  color: ${fg};
}
/* Element-level repaint, the half of readest's getColorStyles this sheet was
   missing. html/body alone only reaches text that inherits straight from the
   root; a Calibre-converted book restates color on every one of its own
   classes (and inline on spans), so the page came up in print black on the
   night fill — measured on a converted EPUB, where the paragraph colour
   stayed rgb(0, 0, 0) while only the headings that happened to use the
   accent colour survived. These selectors carry !important so they also beat
   an inline style="color: …", which is the whole point. background-color is
   deliberately NOT forced here: the section's own backgrounds go through the
   paginator's --override-color resolver, which keeps image-bearing paper
   (Kindle textures) in its original colours. */
section, aside, blockquote, article, nav, header, footer, main, figure,
div, p, font, h1, h2, h3, h4, h5, h6, li, span, td, th, dd, dt, b, i, em,
strong, small, sup, sub, label, caption, figcaption, pre, code, q, cite {
  color: ${fg} !important;
}
a:any-link {
  color: lightblue;
}
/* Hardcoded black text the book shipped for white paper, including the
   rgb(0, 126, 221)-style accents that Calibre conversions sprinkle on Latin
   runs. */
font[color="#000000"], font[color="#000"], font[color="black"],
font[color="rgb(0,0,0)"], font[color="rgb(0, 0, 0)"],
*[style*="color: rgb(0,0,0)"], *[style*="color: rgb(0, 0, 0)"],
*[style*="color: #000"], *[style*="color: #000000"], *[style*="color: black"],
*[style*="color:rgb(0,0,0)"], *[style*="color:rgb(0, 0, 0)"],
*[style*="color:#000"], *[style*="color:#000000"], *[style*="color:black"] {
  color: ${fg} !important;
}
/* Callout boxes with inline white/light backgrounds (readest's
   getDarkModeLightBackgroundOverrides). */
*[style*="background-color: #fff"], *[style*="background-color:#fff"],
*[style*="background-color: #ffffff"], *[style*="background-color:#ffffff"],
*[style*="background-color: white"], *[style*="background-color:white"],
*[style*="background: #fff"], *[style*="background:#fff"],
*[style*="background: #ffffff"], *[style*="background:#ffffff"],
*[style*="background: white"], *[style*="background:white"],
*[style*="background-color: rgb(255"], *[style*="background-color:rgb(255"],
*[style*="background: rgb(255"], *[style*="background:rgb(255"] {
  background-color: ${bg} !important;
}${
    invertImages
      ? `
/* Opt-in, and dark-only: a night reader who wants fewer lumens can have the
   book's pictures inverted too. Off by default — see FoliateStyle. */
img, svg, video, canvas, image {
  filter: invert(1) hue-rotate(180deg);
}`
      : ""
  }`;
};
