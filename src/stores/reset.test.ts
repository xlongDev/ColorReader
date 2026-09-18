import { afterEach, describe, expect, it } from "vitest";

import { resetAllSettings } from "@/stores/reset";
import { DEFAULT_SETTINGS, useSettings } from "@/stores/settings";
import { DEFAULT_READER_SETTINGS, useReaderSettings } from "@/stores/reader";

describe("resetAllSettings", () => {
  afterEach(() => {
    useSettings.setState(DEFAULT_SETTINGS);
    useReaderSettings.setState(DEFAULT_READER_SETTINGS);
  });

  it("puts both persisted stores back to what the app shipped with", () => {
    useSettings.setState({ theme: "dark", shelfLayout: "list", sidebarCollapsed: true });
    useReaderSettings.setState({ fontSize: 26, marginX: 160, surface: "sepia" });

    resetAllSettings(false);

    expect(useSettings.getState().theme).toBe("system");
    expect(useSettings.getState().shelfLayout).toBe("grid");
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
    expect(useReaderSettings.getState().fontSize).toBe(18);
    expect(useReaderSettings.getState().marginX).toBe(DEFAULT_READER_SETTINGS.marginX);
    expect(useReaderSettings.getState().surface).toBe("standard");
  });

  it("re-snapshots the page palette instead of leaving it undecided", () => {
    // The one default that is not free. A reset that dropped `pageTheme` back
    // to `null` would quietly hand the reader back the setting that makes
    // foliate re-paginate the whole book on every theme switch — the thing
    // the snapshot exists to avoid.
    useReaderSettings.setState({ pageTheme: "day" });
    resetAllSettings(true);
    expect(useReaderSettings.getState().pageTheme).toBe("night");
  });
});
