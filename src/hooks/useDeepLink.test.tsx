import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { useDeepLink } from "./useDeepLink";

// The plugin is the OS seam: what it is handed is what the app acts on.
const { getCurrent, onOpenUrl } = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent, onOpenUrl }));
vi.mock("@/lib/ipc", () => ({ isDesktopRuntime: true }));

const BOOK = "6f1d2c3e-0000-4000-8000-000000000001";
const NOTE = "9a2b4c6d-0000-4000-8000-000000000002";

// `vi.fn()` call logs survive `restoreAllMocks` (which only covers `spyOn`), so
// each case starts from a clean registration.
beforeEach(() => {
  getCurrent.mockReset();
  onOpenUrl.mockReset();
  getCurrent.mockResolvedValue(null);
  onOpenUrl.mockResolvedValue(() => {});
});

/** Where the app ended up, as the reader's own query parameters. */
function Probe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function mount() {
  renderHook(() => useDeepLink(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/"]}>
        {children}
        <Probe />
      </MemoryRouter>
    ),
  });
}

const location = () => screen.getByTestId("location").textContent;

describe("useDeepLink", () => {
  it("follows the link the app was launched with", async () => {
    getCurrent.mockResolvedValue([`colorreader://book/${BOOK}?annotation=${NOTE}`]);
    mount();

    await waitFor(() => expect(location()).toBe(`/reader?book=${BOOK}&annotation=${NOTE}`));
  });

  it("follows a link that arrives while the app is running", async () => {
    mount();
    await waitFor(() => expect(onOpenUrl).toHaveBeenCalled());
    expect(location()).toBe("/");

    const [handler] = onOpenUrl.mock.calls[0] as [(urls: string[]) => void];
    handler([`colorreader://book/${BOOK}`]);

    await waitFor(() => expect(location()).toBe(`/reader?book=${BOOK}`));
  });

  it("opens the app normally when the link is not one of ours", async () => {
    getCurrent.mockResolvedValue([`https://example.com/book/${BOOK}`]);
    mount();
    await waitFor(() => expect(getCurrent).toHaveBeenCalled());

    expect(location()).toBe("/");
  });

  it("stays put when there is no link at all", async () => {
    mount();
    await waitFor(() => expect(onOpenUrl).toHaveBeenCalled());

    expect(location()).toBe("/");
  });
});
