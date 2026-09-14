/**
 * The `colorreader://` links the app writes into its exported notes, read back.
 *
 * The shape is the one `library/export.rs::link` emits, and both ends are
 * pinned to the same string by tests on either side.
 *
 * A link names a book and a highlight and *nothing else*. That is deliberate:
 * positions are the one thing this app cannot state portably. A foliate
 * highlight is anchored by CFI, a paragraph one by character offset, a PDF one
 * by page, and none of the three converts into the others. The row an id
 * points at already knows which kind it is, so the URL never has to — and the
 * same link keeps working in whichever renderer that book happens to use.
 */

/** The scheme the app answers to; the same string `resource::SCHEME` registers. */
const SCHEME = "colorreader:";

/**
 * The host that marks a link as *this* kind of link. The scheme is shared with
 * the resource protocol the webview streams covers and book files through
 * (`colorreader://localhost/…`), and that one is not something a reader follows.
 */
const LINK_HOST = "book";

export interface DeepLink {
  bookId: string;
  /** The highlight to land on, or `null` for a link that only names a book. */
  annotationId: string | null;
}

/**
 * Reads a link, or answers `null` for anything that is not one.
 *
 * Total by design: the string arrives from the operating system, which will
 * hand over whatever a browser, a note app or a user's shell decided to send.
 * Nothing here is trusted, and a link that does not parse is simply not acted
 * on.
 */
export function parseDeepLink(url: string): DeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME || parsed.host !== LINK_HOST) return null;

  let bookId: string;
  try {
    bookId = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    // A stray `%` in the path: not a link this app wrote.
    return null;
  }
  if (bookId === "") return null;

  return { bookId, annotationId: parsed.searchParams.get("annotation") || null };
}

/**
 * The in-app route for a link: the reader's own query parameters, so the deep
 * link and a search result arrive the same way.
 */
export function deepLinkRoute(link: DeepLink): string {
  const params = new URLSearchParams({ book: link.bookId });
  if (link.annotationId !== null) params.set("annotation", link.annotationId);
  return `/reader?${params.toString()}`;
}
