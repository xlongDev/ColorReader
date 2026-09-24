/**
 * Handing bytes to the browser as a download.
 *
 * The web build's answer to the desktop's save panel. There is no filesystem to
 * write to and no panel to ask, so a Blob plus a synthetic click on an anchor is
 * the whole mechanism — and the name is the one the reader would have been shown
 * in that panel (`useSavePath` returns the suggested filename in this build).
 *
 * `navigator.share` is deliberately not used: on a desktop browser it either
 * lies about accepting files or pops a sheet anchored to nothing, and a reader
 * who asked to save a book wants the file in their downloads, not a share
 * target. Phones are the one place it would help, and this build is not aimed
 * at them.
 */

/** One object URL per download, revoked after the click has been read. */
const REVOKE_DELAY_MS = 1_000;

/** Triggers a download of `bytes` under `filename`. */
export function downloadBytes(
  bytes: ArrayBuffer | Blob,
  filename: string,
  type = "application/octet-stream",
): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // 🔴 The anchor is left visible on purpose. An empty one lays out as a 0×0
  // inline box, so it disturbs nothing — while `display: none` (or `hidden`)
  // makes WebKit refuse to synthesise the download from the click at all. That
  // is how this was found: the export worked in Chromium and did nothing at all
  // in WebKit, silently, with the same bytes and the same name.
  document.body.append(anchor);
  anchor.click();
  // Both cleanups wait a turn, for the same reason: WebKit also cancels a
  // download whose anchor has already left the document, and Safari reads the
  // object URL after the click returns.
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
