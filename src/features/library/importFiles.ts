import { open } from "@tauri-apps/plugin-dialog";

import { PACK_EXTENSIONS } from "@/features/library/pack";

/** Every extension `BookFormat::from_path` accepts; kept here so the dialog and
    the Rust side never drift apart. */
export const BOOK_EXTENSIONS = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "prc",
  "fb2",
  "cbz",
  "txt",
  "md",
  "markdown",
] as const;

/** Native open dialog, restricted to the formats the library understands. */
export async function pickFiles(): Promise<string[]> {
  try {
    const picked = await open({
      multiple: true,
      title: "选择要导入的书籍",
      filters: [
        {
          name: "书籍与书档",
          extensions: [...BOOK_EXTENSIONS, ...PACK_EXTENSIONS],
        },
      ],
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    // Outside the Tauri shell there is no dialog; importing stays desktop-only.
    return [];
  }
}
