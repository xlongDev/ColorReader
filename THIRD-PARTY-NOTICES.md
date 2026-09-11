# Third-party notices

ColorReader is licensed under **GNU AGPL-3.0-or-later** (see `LICENSE`).
The components below are redistributed or adapted under their own licenses.

## foliate-js (readest fork) — MIT

- Project: <https://github.com/readest/foliate-js> (vendored, upstream:
  <https://github.com/johnfactotum/foliate-js>)
- Version: readest fork `main`, vendored verbatim under `src/vendor/foliate-js/`
- License: MIT — full text in `src/vendor/foliate-js/LICENSE` and
  `THIRD-PARTY-foliate-js-LICENSE`
- Copyright (c) 2022 John Factotum

Used as the reflowable rendering engine and the MOBI / AZW / AZW3 (KF6/KF7/KF8)
container parser: `makeBook()` from `view.js` and the `MOBI` class from
`mobi.js`. Loaded as a lazy chunk, imported at runtime only when a
Kindle-format book is opened.

Local patches (documented inline, kept minimal):

- `pdf.js`: the `@pdfjs/pdf.min.mjs` loader is stubbed out — ColorReader renders
  PDFs through its own pdf.js pipeline, so foliate's PDF path is never entered.
- `fixed-layout.js`: dropped the `construct-style-sheets-polyfill` import —
  constructable stylesheets ship in every Tauri webview this app targets.

## readest — AGPL-3.0-or-later (reference implementation)

- Project: <https://github.com/readest/readest>
- License: GNU AGPL-3.0-or-later

readest is credited as the reference implementation for the Kindle reading
path. Its Tauri architecture (Rust side does only cover + hashing, foliate-js
owns document parsing) and its `<foliate-view>` integration informed the design
of `src/features/reader/FoliateBookView.tsx`; its MIT-licensed foliate-js fork
is vendored (see above). readest's own AGPL source files are not shipped.

## pdf.js — Apache-2.0

- Project: <https://github.com/mozilla/pdf.js>
- Vendored build assets under `public/pdfjs/`.

## React, Vite, Tailwind CSS, TanStack Query, Zustand, Motion, Tauri

Each under its own license (MIT / Apache-2.0); see `node_modules/<pkg>/LICENSE`.
