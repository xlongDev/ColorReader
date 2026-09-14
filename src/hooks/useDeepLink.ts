import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

import { deepLinkRoute, parseDeepLink } from "@/lib/deeplink";
import { isDesktopRuntime } from "@/lib/ipc";

/**
 * Follows the `colorreader://` links the operating system hands the app.
 *
 * Mounted once, inside the router, because a link arrives from outside on
 * whichever route the reader happens to be on — and following it means "open
 * this highlight", so it navigates rather than pushing a page onto whatever
 * the reader was doing.
 *
 * Both arrivals are covered: the app already running (`onOpenUrl`) and the app
 * launched *by* the link, which is the usual case for a link in someone else's
 * notes (`getCurrent`).
 */
export function useDeepLink() {
  const navigate = useNavigate();

  const follow = useCallback(
    (urls: string[] | null) => {
      // The OS hands over a list to match macOS's own API; a link arrives
      // alone in practice, and the first one that parses is the one to open.
      const link = urls?.map(parseDeepLink).find((parsed) => parsed !== null);
      if (link) navigate(deepLinkRoute(link));
    },
    [navigate],
  );

  useEffect(() => {
    if (!isDesktopRuntime) return;
    let stop: (() => void) | null = null;
    let live = true;

    void (async () => {
      follow(await getCurrent());
      const unlisten = await onOpenUrl(follow);
      // Registering is a round trip, so the shell can be gone by the time it
      // lands. Assigning straight into `stop` (as the listeners elsewhere do)
      // would drop it on the floor and leave the subscription live for good —
      // this one mounts once per window, so the leak would last the session.
      if (live) stop = unlisten;
      else unlisten();
    })();

    return () => {
      live = false;
      stop?.();
    };
  }, [follow]);
}
