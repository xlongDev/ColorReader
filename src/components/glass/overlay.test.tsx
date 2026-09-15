import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { OverlayPortal } from "./overlay";

/**
 * The reading pane carries a `backdrop-filter`, which makes it the containing
 * block for `position: fixed` descendants — and it has `overflow: hidden` on
 * top. Floating UI rendered inside it is therefore positioned from the pane's
 * own origin and sliced at the pane's edge, so it is portalled to the shell's
 * host instead.
 */
describe("OverlayPortal", () => {
  it("renders into the shell's overlay host", () => {
    const host = document.createElement("div");
    host.setAttribute("data-overlay-host", "");
    document.body.append(host);

    render(
      <OverlayPortal>
        <p>toolbar</p>
      </OverlayPortal>,
    );

    expect(host.contains(screen.getByText("toolbar"))).toBe(true);
    host.remove();
  });

  it("renders in place when there is no host to portal into", () => {
    const { container } = render(
      <OverlayPortal>
        <p>inline</p>
      </OverlayPortal>,
    );
    expect(container.contains(screen.getByText("inline"))).toBe(true);
  });
});
