/**
 * A book title is not a filename.
 *
 * Slashes and colons are legal in one and not the other, and a save dialog that
 * opens on a broken path is a dead end: the reader picks a name and the panel
 * refuses it, with no way to tell which character was the problem. Control
 * characters are refused for the same reason — a title carrying a newline (a
 * badly made container will do it) would break the path outright.
 *
 * Both export dialogs ask for a name through here, so they cannot drift apart.
 */

/**
 * Path separators, the characters Windows reserves, and the Unicode `Control`
 * category — which is where a stray newline out of a badly made container
 * lands, and what a path cannot carry.
 */
const ILLEGAL = /[\p{Cc}/\\:*?"<>|]/gu;

/**
 * `title` reduced to something every filesystem accepts.
 *
 * `fallback` covers the title that was nothing but illegal characters or
 * whitespace — an empty name is the one outcome a save panel cannot recover
 * from, since it offers the reader no field to correct.
 */
export function filename(title: string, fallback: string): string {
  const cleaned = title.replace(ILLEGAL, "_").trim();
  return cleaned || fallback;
}
