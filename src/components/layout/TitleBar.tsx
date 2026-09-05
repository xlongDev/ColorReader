/**
 * Drag band above the content. On macOS the window uses an overlay title bar,
 * so the traffic lights sit inside this region; on Windows/Linux it is the
 * strip you grab to move the window.
 */
export function TitleBar() {
  return <div data-tauri-drag-region className="h-9 shrink-0" />;
}
