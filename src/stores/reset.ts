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
 * `appIsDark` is the theme of the moment, and it is here because a reset drops
 * `pageTheme` back to "undecided". Resolving it straight away keeps a restore
 * from silently re-introducing the one setting whose undecided value is the
 * expensive one on a foliate book — the page would follow the app theme again
 * and re-paginate on every theme switch.
 */
export function resetAllSettings(appIsDark: boolean): void {
  useSettings.setState(DEFAULT_SETTINGS);
  useReaderSettings.setState(DEFAULT_READER_SETTINGS);
  useReaderSettings.getState().snapPageTheme(appIsDark);
}
