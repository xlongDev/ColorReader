import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { isDesktopRuntime } from "@/lib/ipc";

/**
 * Window-level drag and drop, driven by Tauri's webview events.
 *
 * The shell keeps its native drag-drop handler enabled, which suppresses the
 * DOM `drop` event but reports real absolute file paths, which is what the
 * import pipeline needs. Outside the Tauri shell this stays inert.
 */
export function useDragDropImport(onDrop: (paths: string[]) => void): boolean {
  const [dragging, setDragging] = useState(false);

  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  useEffect(() => {
    if (!isDesktopRuntime) return undefined;

    let active = true;
    let unlisten: (() => void) | undefined;

    const promise = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (!active) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragging(true);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        latest.current(event.payload.paths);
      } else {
        setDragging(false);
      }
    });
    void promise.then((stop) => {
      unlisten = stop;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return dragging;
}
