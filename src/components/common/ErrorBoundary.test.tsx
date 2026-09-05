import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): ReactNode {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React reports caught render errors through console.error; keep it out of
    // the test output so the real failures stay visible.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children while nothing throws", () => {
    render(
      <ErrorBoundary scope="测试">
        <p>内容</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("replaces the subtree with a fallback that names the scope and the error", () => {
    render(
      <ErrorBoundary scope="页面">
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("这个界面出错了")).toBeInTheDocument();
    expect(screen.getByText(/页面渲染时抛出异常/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
