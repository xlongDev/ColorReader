import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import "@/styles/globals.css";
// LXGW WenKai ships its own `@font-face` declarations. Importing the styles
// here registers the family globally so it is available everywhere — the
// reader's font picker, the notes editor, anywhere that reads a font stack
// from `theme.ts`. The 29 MB of subset woff2 files only download when the
// browser sees a glyph from the corresponding `unicode-range`, so the cost
// of an unused font is zero.
import "lxgw-wenkai-webfont/style.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root not found");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary scope="应用">
      <AppRouter />
    </ErrorBoundary>
  </StrictMode>,
);
