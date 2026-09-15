import { useEffect, useState } from "react";

import { ipc } from "@/lib/ipc";

/** MIME for an asset path extension; the webview only renders these. */
export function assetMime(path: string): string {
  // Kindle image references declare their type inline: kindle:embed:…?mime=image/jpeg
  const declared = /[?&]mime=([\w/+.-]+)/.exec(path)?.[1];
  if (declared?.startsWith("image/")) return declared;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/jpeg";
}

/**
 * Blob URL for one in-book asset, fetched lazily from the source file. A null
 * path (no asset for this chapter) never touches the archive.
 */
export function useAssetUrl(bookId: string, path: string | null): string | null {
  // Landed result keyed by its path: a null path never enters the effect, and
  // the render-time key check drops a stale URL the tick a path changes.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setLoaded({ path, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);
  return loaded && loaded.path === path ? loaded.url : null;
}
