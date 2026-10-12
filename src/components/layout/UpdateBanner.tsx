import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DownloadSimple, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { isDesktopRuntime } from "@/lib/ipc";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
import { useUpdater } from "@/stores/updater";
import { useChrome } from "@/stores/chrome";

/**
 * How long after launch the one automatic check waits, in ms.
 *
 * Long enough that the request to GitHub cannot compete with the first paint
 * of the shelf, short enough that a reader who opens the app and walks away
 * still comes back to the notice. The check is a single GET of `latest.json`.
 */
const CHECK_DELAY_MS = 8_000;

/**
 * The surface an update announces itself on.
 *
 * The updater used to be reachable only from 设置 › 关于 › 检查更新, which
 * meant the auto-update mechanism shipped without a way for most installs to
 * ever meet a new version: nobody opens that row unprompted. This is the
 * missing half — one delayed check per launch, and a slim bar the reader can
 * act on or dismiss.
 *
 * Three deliberate restraints:
 *
 * - **It only raises for a release that is ready.** A failed launch check says
 *   nothing: the reader did not ask, and an unexplained red bar at every boot
 *   is noise. Failures still show in 设置, on the row they pressed.
 * - **It never installs on its own.** The bar offers 安装并重启 and waits.
 * - **It stays out of the immersive reader.** Hidden while the reading surface
 *   is fullscreen; the notice is there when the reader comes back.
 *
 * State lives in the `useUpdater` store, so the 设置 row and this bar can never
 * disagree — installing from either one moves both.
 */
export function UpdateBanner() {
  const { state, installAndRestart } = useUpdater();
  const readerFullscreen = useChrome((s) => s.readerFullscreen);
  const [dismissed, setDismissed] = useState(false);
  const m = useMotion();

  useEffect(() => {
    if (!isDesktopRuntime) return;
    const timer = window.setTimeout(
      () => void useUpdater.getState().checkForUpdate(),
      CHECK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  const version = state.status === "available" ? state.version : null;
  const open =
    !dismissed &&
    !readerFullscreen &&
    (state.status === "available" || state.status === "downloading");

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: m.reduce ? 0 : -m.rise }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: m.reduce ? 0 : -m.rise }}
          // A duration, not `m.enter`: this is the same choice `SpeechCard`
          // makes for its exits — a spring on a leaving element keeps the
          // element mounted for the whole settle, and nothing here needs a
          // bounce on the way out.
          transition={{ duration: DURATION.fast, ease: EASE_OUT }}
          aria-live="polite"
          data-update-banner
          className="glass-2 border-hairline shadow-panel mx-3 mt-2 flex items-center gap-3 rounded-lg border px-3.5 py-2"
        >
          <DownloadSimple size={16} className="text-accent shrink-0" aria-hidden />
          <p className="text-text-1 flex-1 text-[13px] leading-relaxed">
            {version !== null ? (
              <>
                发现新版本 <span className="font-medium">{version}</span>
              </>
            ) : state.status === "downloading" ? (
              <>正在下载更新{state.percent === null ? "…" : ` ${state.percent}%`}</>
            ) : null}
          </p>
          {state.status === "available" && (
            <GlassButton
              size="sm"
              variant="primary"
              onClick={() => void installAndRestart()}
              className="shrink-0"
            >
              安装并重启
            </GlassButton>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="关闭更新提示"
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring shrink-0 rounded-md p-1 transition-colors duration-150"
          >
            <X size={14} aria-hidden />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
