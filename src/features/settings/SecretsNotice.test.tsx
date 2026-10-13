import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SecretsNotice } from "./SecretsNotice";
import type { SecretsStatus } from "@/types/ipc";

/** Driven directly: the hook is a one-shot query, so what this file pins is the
 *  rendering decision, not the fetching. */
let status: SecretsStatus | undefined;
let desktop = true;

vi.mock("@/hooks/useSystemInfo", () => ({
  useSecretsStatus: () => ({ data: status }),
}));
vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return desktop;
  },
}));

beforeEach(() => {
  desktop = true;
  status = { available: true, detail: null };
});

const notice = () => document.querySelector("[data-secrets-notice]");

describe("SecretsNotice", () => {
  it("says nothing when credentials can be sealed", () => {
    render(<SecretsNotice />);
    expect(notice()).toBeNull();
  });

  it("says nothing while the answer is still unknown", () => {
    // A warning that flashes before the backend has answered would be worse
    // than no warning: it would be wrong for a moment on every page load.
    status = undefined;
    render(<SecretsNotice />);
    expect(notice()).toBeNull();
  });

  it("shows the backend's own sentence when they cannot", () => {
    const detail = "系统钥匙串不可用（本平台没有可用的凭据存储），凭据只能以明文保存在本机";
    status = { available: false, detail };
    render(<SecretsNotice />);
    // Verbatim, not re-worded: the backend is the side that knows whether the
    // store is missing or the credentials in it are unopenable, and those two
    // ask the reader for different things.
    expect(notice()?.textContent).toBe(detail);
  });

  it("says nothing in the browser, where there are no credentials to store", () => {
    // The browser build answers `available: false` truthfully, and would
    // otherwise put a warning about a problem it does not have on the page.
    desktop = false;
    status = { available: false, detail: "浏览器构建没有系统钥匙串，且不保存任何凭据" };
    render(<SecretsNotice />);
    expect(notice()).toBeNull();
  });
});
