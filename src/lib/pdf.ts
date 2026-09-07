import type { PDFDocumentProxy } from "pdfjs-dist";
import type * as PdfjsModule from "pdfjs-dist";

import { ipc, isDesktopRuntime } from "@/lib/ipc";

/**
 * Everything pdf.js, in one place: the lazy loader, the per-book document
 * cache, the bookmark outline and the first-page cover renderer. The reader,
 * the table of contents and the library's cover backfill all share this
 * module, so the library chunk only loads when a PDF actually needs it.
 */

let pdfjsPromise: Promise<typeof PdfjsModule> | null = null;

/** Loads pdf.js once. The worker's hashed asset URL comes from Vite's `?url`
    resolution, resolved at build time and handed to the library. */
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();

/** One document per book per session: pdf.js parses the byte stream once and
    the reader then only asks for pages as the user flips. */
export function loadDoc(bookId: string): Promise<PDFDocumentProxy> {
  const cached = docs.get(bookId);
  if (cached) return cached;
  const promise = (async () => {
    const pdfjs = await loadPdfjs();
    if (!isDesktopRuntime) throw new Error("PDF 阅读只能在桌面端使用");
    const bytes = new Uint8Array(await ipc.bookFile(bookId));
    return pdfjs.getDocument({
      data: bytes,
      // JPEG2000 and JBIG2 page images decode in the worker through the wasm
      // files copied into `public/pdfjs/`; without them such pages (very
      // common as a book's cover page) render as blank white.
      wasmUrl: `${import.meta.env.BASE_URL}pdfjs/`,
    }).promise;
  })();
  docs.set(bookId, promise);
  return promise;
}

/** One entry of a PDF's bookmark outline, flattened in reading order. */
export interface PdfOutlineItem {
  title: string;
  /** 0-based page the entry points at. */
  page: number;
  /** Nesting level, 0-based; the reader indents by this. */
  depth: number;
}

const MAX_OUTLINE_ITEMS = 2048;

/** The document's own bookmarks, with every destination resolved to a page
    index. pdf.js does the heavy lifting here — named destinations, `/A`
    actions and UTF-16 titles included — which a hand-rolled walker gets
    wrong on real-world files. */
export async function readPdfOutline(bookId: string): Promise<PdfOutlineItem[]> {
  const doc = await loadDoc(bookId);
  const root = (await doc.getOutline()) ?? [];

  // Pass 1 (synchronous): flatten the bookmark tree in reading order with an
  // explicit stack — children right after their parent, depth attached.
  type Node = { item: (typeof root)[number]; depth: number };
  const ordered: Node[] = [];
  const stack: Node[] = root.toReversed().map((item) => ({ item, depth: 0 }));
  while (stack.length > 0 && ordered.length < MAX_OUTLINE_ITEMS) {
    const node = stack.pop()!;
    ordered.push(node);
    stack.push(...node.item.items.toReversed().map((item) => ({ item, depth: node.depth + 1 })));
  }

  // Pass 2: resolve every destination in parallel, keeping the order.
  const pages = await Promise.all(
    ordered.map(async ({ item }) => {
      let dest = item.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) {
        try {
          return await doc.getPageIndex(dest[0] as NonNullable<(typeof dest)[number]>);
        } catch {
          return -1; // Destination points outside the document; entry is dead.
        }
      }
      return -1;
    }),
  );

  return ordered
    .map(({ item, depth }, index) => ({ title: item.title ?? "", page: pages[index] ?? -1, depth }))
    .filter((entry) => entry.title !== "" && entry.page >= 0);
}

const aspects = new Map<string, Promise<number>>();

/** Height/width ratio of page 1, for sizing the scroll view's page slots.
    `ponytail:` assumes one page size for the whole document; mixed sizes get
    per-page heights if the mismatch ever jars. */
export function loadPageAspect(bookId: string): Promise<number> {
  let cached = aspects.get(bookId);
  cached ??= loadDoc(bookId).then(async (doc) => {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    return base.height / base.width;
  });
  aspects.set(bookId, cached);
  return cached;
}

/** Renders page 1 as a PNG blob, sized for a shelf cover. Used to backfill
    covers for PDFs, whose first page is the only cover they have. Rejects
    blank renders (undecodable cover images) so the shelf keeps its
    placeholder instead of a white rectangle. */
export async function renderFirstPagePng(bookId: string): Promise<ArrayBuffer> {
  const doc = await loadDoc(bookId);
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 600 / base.width);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建封面画布");
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  // pdf.js paints undecodable images as pure white on a white page; a cover
  // where every channel is ~255 carries no information, so refuse it.
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let inked = false;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! < 250 || pixels[i + 1]! < 250 || pixels[i + 2]! < 250) {
      inked = true;
      break;
    }
  }
  if (!inked) throw new Error("首页渲染为空白，不作为封面");

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("封面导出失败");
  return blob.arrayBuffer();
}
