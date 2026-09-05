import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, describeError } from "./log";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a readable line plus a structured payload", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    createLogger("unit").info("hello", { bookId: "b1", count: 2 });

    expect(info).toHaveBeenCalledWith("[info] unit: hello", {
      scope: "unit",
      message: "hello",
      bookId: "b1",
      count: 2,
    });
  });

  it("routes each level to the matching console method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("unit");

    log.warn("careful");
    log.error("broken");

    expect(warn).toHaveBeenCalledWith("[warn] unit: careful", {
      scope: "unit",
      message: "careful",
    });
    expect(error).toHaveBeenCalledWith("[error] unit: broken", {
      scope: "unit",
      message: "broken",
    });
  });
});

describe("describeError", () => {
  it("unwraps Error instances", () => {
    expect(describeError(new TypeError("bad type"))).toEqual({
      name: "TypeError",
      message: "bad type",
    });
  });

  it("handles thrown strings and unknown values", () => {
    expect(describeError("just a string")).toEqual({
      name: "Error",
      message: "just a string",
    });
    expect(describeError(null)).toEqual({ name: "Error", message: "未知错误" });
    expect(describeError({ code: 7 })).toEqual({ name: "Error", message: "未知错误" });
  });
});
