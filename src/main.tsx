import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { MiniBar } from "@/features/reader/MiniBar";
import "@/styles/globals.css";
// 🔴 LXGW WenKai is deliberately NOT imported here. Its 582 `@font-face` rules
// are 539 KB — the single largest thing in the first paint — and the font is
// the fifth option in a picker whose default is 「系统」, so almost every
// session was paying to parse a family it never used. It loads on demand
// instead: `useBundledFont` fetches the sheet when the reader picks it, and
// nothing else in the app needs the rules in the document. The 29 MB of subset
// woff2 were never the cost — they only download when a glyph falls in their
// `unicode-range`, and a section fetches only the handful its own glyphs hit.

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
