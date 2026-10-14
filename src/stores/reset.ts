import { forgetCatalogFonts } from "@/features/reader/catalogFont";
import { DEFAULT_SETTINGS, useSettings } from "@/stores/settings";
import { DEFAULT_READER_SETTINGS, useReaderSettings } from "@/stores/reader";

/**
 * Put every preference back the way the app shipped.
 *
 * Only the two persisted stores are in scope — the app preferences and the
 * reading ones. Deliberately not touched: books, annotations and notes (the
 * backend's own data), imported dictionaries and fonts, and the AI and sync
 * configurations, which are credentials and endpoints rather than preferences
 * and would be actively hostile to wipe.
 *
 * Catalogue fonts are the exception among fonts, and the line is not
 * arbitrary: an *imported* font is a file the reader put on this machine, and
 * nothing in the two stores is the only record of it. A *catalogue* font is a
 * `downloadedFonts` entry and a sheet fetched from a CDN — both of which this
 * reset clears, and both of which it can fetch again. Leaving the sheet behind
 * would leave a family declared in the document with nothing in the settings
 * to explain it: exactly the state the settings row exists to make
 * impossible, and one the reader cannot undo without a reinstall. See
 * `forgetCatalogFonts`.
 *
 * `appIsDark` is the theme of the moment, and it is here because a reset drops
 * `pageTheme` back to "undecided". Resolving it straight away keeps a restore
 * from silently re-introducing the one setting whose undecided value is the
 * expensive one on a foliate book — the page would follow the app theme again
 * and re-paginate on every theme switch.
 */
export function resetAllSettings(appIsDark: boolean): void {
  useSettings.setState(DEFAULT_SETTINGS);
  useReaderSettings.setState(DEFAULT_READER_SETTINGS);
  // 🔴 After the reader store, never before. `fontFamily` is back on 原书 by
  // this line, so no render can be holding a `catalog:*` key while its sheet
  // is being taken out of the document — `useAdoptedFontKey` reads "key with
  // no face adopted" as *not installed yet* and would go and fetch the sheet
  // again, which is the one thing a reset must not cause. (Today both orders
  // end at the same render, because React batches the store writes; the order
  // is what keeps that from being load-bearing.)
  forgetCatalogFonts();
  useReaderSettings.getState().snapPageTheme(appIsDark);
}
