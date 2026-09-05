import { beforeEach, describe, expect, it } from "vitest";

import { useCommandStore } from "@/stores/commands";
import { useSettings } from "@/stores/settings";
import type { Command } from "@/lib/commands";

const alpha: Command = { id: "a", title: "A", group: "g", run: () => {} };
const beta: Command = { id: "b", title: "B", group: "g", run: () => {} };

describe("useCommandStore", () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [] });
  });

  it("registers commands", () => {
    useCommandStore.getState().register([alpha]);
    expect(useCommandStore.getState().commands.map((c) => c.id)).toEqual(["a"]);
  });

  it("replaces an existing command with the same id instead of duplicating", () => {
    useCommandStore.getState().register([alpha]);
    useCommandStore.getState().register([{ ...alpha, title: "A2" }]);
    const commands = useCommandStore.getState().commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]?.title).toBe("A2");
  });

  it("unregisters by id", () => {
    useCommandStore.getState().register([alpha, beta]);
    useCommandStore.getState().unregister(["a"]);
    expect(useCommandStore.getState().commands.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("useSettings", () => {
  beforeEach(() => {
    useSettings.setState({
      theme: "system",
      transparency: "full",
      sidebarCollapsed: false,
    });
  });

  it("defaults to following the system theme", () => {
    expect(useSettings.getState().theme).toBe("system");
  });

  it("updates the theme", () => {
    useSettings.getState().setTheme("dark");
    expect(useSettings.getState().theme).toBe("dark");
  });

  it("toggles the sidebar", () => {
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });
});
