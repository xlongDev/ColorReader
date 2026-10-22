---
version: 2
slug: "quote-card"
primary_target: "quote-card"
related_targets: ["src/features/reader/quoteCard.ts", "src/features/reader/QuoteCardDialog.tsx"]
---

## Direction contract — 金句卡片（quote card）

THESIS: The card is a page torn out of the reader's own book. It refuses the
generic quote-card template (gradient text, centered hero, decorative borders):
the paper IS the reading surface the page is on right now, the ink IS their
highlight colour painted as a real highlighter wash behind the words, the
voice IS their reading font, and the cover IS the book they are reading. Category
default it refuses: the fixed branded card that looks the same no matter who
shares it.

OWN-WORLD: Reading-surface paper (`useReadingSurface` — the same resolution the
reading page uses, never a second one written by hand) with its AA-checked ink;
quote text in the reader's font stack (`resolveFont` + `--font-sans` literal);
highlighter wash = `annotation.color` at low alpha; the cover, when the book has
one, as a contained 168x236 rounded thumbnail top-left with the book's name
beside it — centre-cropped like every cover in the app (`coverCrop`), one
hairline, never a full-bleed backdrop; QR in a white rounded plate bottom-right
(scannable on any paper); small caps-free metadata line. No new tokens, no new
components — GlassDialog for the preview, GlassButton for the save.

STORY: A reader finishing a passage presses the share glyph on one highlight
row, sees the card already rendered on their own paper — their surface, their
font, their mark, their book's cover — presses 保存, and the native panel names
the file. What they understand: this is MY page, with MY mark, from MY book —
and the QR carries it back to the exact highlight.

INVARIANTS (each one is a test, and each one was a real bug):

- **One resolution of the paper.** The dialog reads `useReadingSurface()`, which
  picks `nightSurface` on a night page and `surface` on a day one. The first
  build read the day surface unconditionally and a reader reported every card
  coming out one colour no matter which surface was picked; the regression test
  sets sepia on the day side and pine on the night side and demands pine.
- **No cover, no cover-shaped hole.** A book without one draws exactly the card
  that existed before covers did: one muted metadata line, quote zone at its
  original top. Degradation is the default path, not a fallback branch.
- **The bottom never moves.** With a cover the quote zone's top drops 84px; the
  progress line, wordmark and QR plate stay where they were, pixel for pixel.
- **The cover is never stale.** The decoded image is stored with the URL it came
  from and read back through that URL, so switching books cannot leave the
  previous book's picture on the card.
- **The crop reaches the whole image.** A nine-argument drawImage straight off
  an SVG mis-samples on a canvas this size (Chromium: the crop selected the
  image's top-left corner and the box came out one flat colour), so the cover
  is composited into an offscreen bitmap first and cropped from that. The e2e
  samples both ends of the box and demands the red channel climb — a flat box
  moves it by hardly anything.

FIRST VIEWPORT (of the card, 1080x1440, 3:4): with a cover — the thumbnail at
the top-left margin, the book's name set beside it as one block against the
cover's height, the quote centred below them with the highlighter wash behind
its lines; without one — the single muted metadata line top-left and the quote
in the zone it always occupied. Progress + chapter line below the quote; white
QR plate anchored bottom-right with the deep link inside; a small
"方册" wordmark bottom-left in ink-3. Save button bottom-right of the
preview dialog.

FORM: The dialog is a lightbox over the reading surface (the suggestions doc's
"灯箱"), entry is a per-row glyph in the annotation panel. Save: desktop writes
the PNG through a new `card.save` command (bytes + dialog-chosen path, the
notes-export contract); browser falls back to a download under the offered name.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
