import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { MiniBar } from "@/features/reader/MiniBar";
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

/**
 * The floating read-aloud bar is this same bundle in a second window, told
 * apart by one query parameter (`commands::mini_bar::build_bar` sets it).
 *
 * It mounts its own root rather than a route because the shell is a memory
 * router: there is no URL a second window could be pointed at. It also has to
 * be its own root for a reason that matters more — the providers, and with them
 * the engine, hang off `AppRouter`, and a second engine would mean a second
 * voice.
 *
 * The cost is the whole app being parsed in that window. It is paid once, on
 * the first minimize of a session, and splitting it would mean a `lazy()` entry
 * for the app it belongs to — which is a bigger change to what the first paint
 * downloads than a small window is worth.
 */
const mini = new URLSearchParams(window.location.search).has("mini");
if (mini) {
  // Unlayered and before the first paint: the window is transparent, and the
  // app's own background would otherwise fill the rectangle around the capsule.
  document.documentElement.classList.add("mini-bar");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary scope={mini ? "朗读悬浮条" : "应用"}>
      {mini ? <MiniBar /> : <AppRouter />}
    </ErrorBoundary>
  </StrictMode>,
);
