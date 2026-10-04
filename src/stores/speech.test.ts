import { beforeEach, describe, expect, it } from "vitest";

import { useSpeechSession } from "./speech";

describe("useSpeechSession", () => {
  beforeEach(() => useSpeechSession.setState({ open: false, openAt: "main" }));

  it("opens where it is told, and forgets it on the next plain open", () => {
    useSpeechSession.getState().setOpen(true, "speed");
    expect(useSpeechSession.getState()).toMatchObject({ open: true, openAt: "speed" });

    // The capsule opens the card without naming a view, so it has to land on
    // the transport — not on wherever the reader's 倍速 button last left it.
    // Otherwise one shortcut quietly becomes where every reader starts.
    useSpeechSession.getState().setOpen(false);
    useSpeechSession.getState().setOpen(true);
    expect(useSpeechSession.getState().openAt).toBe("main");
  });

  it("puts the transport back when it is closed", () => {
    useSpeechSession.getState().setOpen(true, "voice");
    useSpeechSession.getState().setOpen(false);
    expect(useSpeechSession.getState()).toMatchObject({ open: false, openAt: "main" });
  });
});
