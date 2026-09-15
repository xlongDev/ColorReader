import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

type Subscribe<T> = (handler: (payload: T) => void) => Promise<UnlistenFn | undefined>;

/**
 * Subscribes to a backend event for as long as the component is mounted.
 *
 * Registering is a round trip: `listen` resolves with the unsubscribe function
 * a few ticks after the effect ran, so the component can already be gone when
 * it lands. Handing it straight to a closure variable — as five listeners in
 * this app did — drops it in that window and leaves the subscription live for
 * the rest of the session. The `live` flag closes the gap.
 *
 * `subscribe` has to be a stable reference, which every `on*` helper in
 * `lib/ipc.ts` is. The handler does not: it is read through a ref, so an
 * inline arrow does not resubscribe on every render.
 */
export function useTauriEvent<T>(subscribe: Subscribe<T>, handler: (payload: T) => void): void {
  const latest = useRef(handler);

  useEffect(() => {
    latest.current = handler;
  }, [handler]);

  useEffect(() => {
    let stop: UnlistenFn | null = null;
    let live = true;

    void subscribe((payload) => latest.current(payload)).then((unlisten) => {
      // Outside the shell the helpers resolve with nothing to unsubscribe.
      if (!unlisten) return;
      if (live) stop = unlisten;
      else unlisten();
    });

    return () => {
      live = false;
      stop?.();
    };
  }, [subscribe]);
}
