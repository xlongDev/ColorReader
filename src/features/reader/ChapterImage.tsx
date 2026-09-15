import { useEffect, useState } from "react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { assetMime } from "@/features/reader/assets";

/**
 * One in-book image, fetched lazily from the source EPUB as a blob URL so a
 * chapter with no images never touches the archive. Clicking opens the
 * lightbox viewer.
 */
export function ChapterImage({
  bookId,
  path,
  onOpen,
  plate = false,
}: {
  bookId: string;
  path: string;
  onOpen: (src: string) => void;
  /** Full-bleed wallpaper form for part-title pages: covers the page box. */
  plate?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    ipc
      .bookAsset(bookId, path)
      .then((buffer) => {
        if (!alive) return;
        // The postMessage IPC fallback (active when the custom-protocol fetch
        // is unavailable) resolves byte arrays as plain JS arrays; normalize
        // before building the blob or it silently becomes a text blob.
        const bytes =
          buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
        url = URL.createObjectURL(new Blob([bytes], { type: assetMime(path) }));
        setSrc(url);
      })
      .catch(() => {
        // A silent failure here reads as a blank page; surface it.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookId, path]);

  if (!src) {
    return failed ? <span className="text-sm opacity-50">图片加载失败:{path}</span> : null;
  }
  return (
    <button
      type="button"
      aria-label="查看图片"
      onClick={() => onOpen(src)}
      className={cn(
        "transition-opacity hover:opacity-90",
        plate ? "block h-full w-full cursor-zoom-in" : "cursor-zoom-in",
      )}
    >
      <img
        src={src}
        alt=""
        className={
          plate
            ? "h-full w-full object-cover"
            : "border-hairline mx-auto max-w-full rounded-lg border"
        }
        draggable={false}
      />
    </button>
  );
}
