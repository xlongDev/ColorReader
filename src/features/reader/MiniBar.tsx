import { useEffect, useLayoutEffect, useState } from "react";
import { BookOpenText, CaretDown } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  askMiniBarState,
  ipc,
  onMiniBarState,
  onMiniBarVoices,
  sendSpeechControl,
  type BarFace,
  type MiniBarState,
  type MiniBarVoices,
} from "@/lib/ipc";
import { SPRING } from "@/lib/motion";

import type { SpeechView } from "./speech";
import { SpeechCard } from "./SpeechCard";
import { barClock, LoadingBars, Pill, Transport } from "./ttsParts";

/**
 * The floating read-aloud bar: read-aloud's third surface, and the only one
 * that is a window rather than a route.
 *
 * It exists because the other two cannot follow the reader out of the app. The
 * in-app pill and the full card both live inside the main window, so minimizing
 * that window — or closing it, which hides rather than quits — takes the
 * transport with it and leaves the menu bar as the only way to pause. This one
 * is a capsule lying on the desktop instead: always on top, so it is still
 * there while the reader is in another app.
 *
 * It draws, and it draws only. The queue, the position, the voice and the
 * engine all belong to the main window, which pushes what to show over
 * `tts://mini-state` and `tts://mini-voices`; this component forwards its
 * gestures back as the same names the tray already uses — plus `focus`, its
 * own one, which asks the main window to come back up on the sentence being
 * read. That is the whole contract, and it is why the bar has no store, no
 * engine and no context — mounting any of those here would start a second
 * voice.
 *
 * Two faces, one window — and the second face has four views. The capsule is
 * the bar at rest; opening it swaps in `SpeechCard`, which is the *app's own*
 * player, so a reader who wants the sentence list and the scrubber gets them
 * without bringing the whole app back — and the reader who wants the app back
 * says so with the book, which is the one thing here that only a route can
 * answer.
 *
 * The two faces are **stacked, not swapped**, and that is the animation: they
 * overlap for the length of a cross-fade, the card rising into place while the
 * capsule fades out from under it. Both are pinned to the window's *bottom*
 * edge, which is the edge the frame keeps when it grows — so the capsule does
 * not move an inch while the card unfolds, and the card's own rise reads as the
 * window opening rather than as two things changing place. On the way back the
 * order is reversed and takes a beat longer: the panel fades away first, the
 * frame only shrinks once the card is gone (`folding`), and the capsule comes
 * back into the place the panel folded into.
 *
 * Which view is up is the card's own business, and this window only repeats it
 * for the backend: 语速 and 定时关闭 are a third of the height of the sentence
 * list, and a window still sized for the list is the empty half of a panel. The
 * card announces the change (`onView`) and it goes straight back out as the
 * face the backend sizes the frame to.
 *
 * The window is moved by hand and has no frame (the shell draws none), so the
 * capsule itself is the drag handle: the title bar of a window this shape is
 * the window.
 */
export function MiniBar() {
  const reduce = useReducedMotion();
  const [state, setState] = useState<MiniBarState | null>(null);
  const [catalogue, setCatalogue] = useState<MiniBarVoices | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The card is on its way out but the window is still the card's. The two are
  // not the same question: the frame has to outlive the card by one animation,
  // or the window shrinks out from under it and the fold becomes a squeeze.
  const [folding, setFolding] = useState(false);
  // Which of the card's views is up. Kept here only to be told to the backend,
  // which is the side that can see the window: the card would report it on its
  // own, but the report arrives one frame after it mounts, and the window would
  // be sized for the view the reader left behind on the way in.
  const [view, setView] = useState<SpeechView>("main");

  useTauriEvent(onMiniBarState, setState);
  useTauriEvent(onMiniBarVoices, setCatalogue);

  // The window is built the moment it is wanted, which is after the state it
  // would have drawn has already gone past, so it asks rather than sitting
  // empty until the next sentence. The ask is put to the main window, which
  // answers with both payloads — the catalogue included, since this window may
  // have been built long after the last one was published.
  useEffect(() => {
    void askMiniBarState();
  }, []);

  // This document is its own; the theme carried in from `index.html` was read at
  // load, and the bar outlives a theme change in the window that owns it. Written
  // straight onto the element the tokens hang off, which is the whole of what the
  // main window does to switch appearance.
  //
  // Before paint, not after: the bar is a separate webview whose first payload
  // and first frame land together, and an effect would show the capsule in the
  // colour this window guessed from the OS before repainting it in the app's.
  // The app theme is the answer even when it disagrees with the system — that is
  // what 设置 → 外观 → 主题 means.
  const theme = state?.theme ?? null;
  useLayoutEffect(() => {
    if (theme === null) return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const live = state?.live === true;
  // Folded, every time. A card left open when a session ends would have the
  // next one open at its own size, which is not what "a voice just started"
  // looks like — so the expansion is dropped with the session, during render,
  // because what matters is what the *last* payload said and an effect would
  // paint the card once more before taking it away.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) {
      setExpanded(false);
      setFolding(false);
      setView("main");
    }
  }

  // A payload for a session that has ended must not be drawn: the shell is a
  // tick behind in taking the window down, and a bar for a finished book is the
  // one frame that would look like a bug. Folded is the same question — the
  // card cannot outlive the session it is listing.
  const cardUp = expanded && live;
  // …and the frame is the card's for as long as the card is on screen, which
  // outlasts `cardUp` by the fold's own animation.
  const holding = cardUp || folding;
  const minimal = state?.minimal === true;
  // The card's view *is* the bar's face; the capsule is the face with no card
  // behind it. One vocabulary, so nothing here translates — and naming the type
  // is what makes a view the backend has no height for a compile error rather
  // than a window of the wrong size.
  const face: BarFace = holding ? view : "capsule";

  // The frame follows the face, and it is the backend that works it out: a
  // webview can see its content and not the window around it. Which face is
  // being drawn is the one thing that decides the height — including 简约,
  // where the card is short because it is missing the two blocks that make it
  // tall, and each drill-down, where it is short because it is one row.
  useEffect(() => {
    void ipc.miniBarExpand(face, minimal);
  }, [face, minimal]);

  /** Folds the card away. The window is held open for the fade, and the view
   *  goes back with it: the card is unmounted while it is folded, so a view
   *  left behind on this side would have the window sized for it once more on
   *  the way back in. */
  const fold = () => {
    setExpanded(false);
    setFolding(true);
  };

  /** The fold has finished drawing. Named for what it *is* rather than for the
   *  animation that announces it, because it is also the end of the `folding`
   *  flag: the frame may shrink now. */
  const folded = () => {
    setFolding(false);
    setView("main");
  };

  if (state === null || !live) return null;

  return (
    <div className="relative h-full w-full">
      {/* Both faces are stacked rather than swapped: they overlap for the
          length of the cross-fade, and the capsule — pinned to the bottom
          edge, which is the edge the window keeps when it grows — does not
          move an inch while the card unfolds around it. */}
      <AnimatePresence onExitComplete={folded}>
        {cardUp && (
          <motion.div
            key="card"
            className="absolute inset-1"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING.panel}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { opacity: 0, y: 12, transition: { duration: 0.16 } }
            }
          >
            <SpeechCard
              // The window *is* the card here: it takes the whole frame, and the
              // 4px around it is the same air the capsule gets.
              className="h-full w-full"
              dragHandle
              title={state.title}
              chapter={state.chapter}
              coverUrl={state.coverUrl}
              units={state.units}
              index={state.index}
              // The pill says the same thing with the same two words: the engine's
              // third state, "idle with a failure", is a session that is not
              // playing, and that is what the button offers to fix.
              status={state.playing ? "playing" : "paused"}
              loading={state.loading}
              error={state.error}
              elapsed={state.elapsed}
              remaining={state.remaining}
              percent={state.percent}
              spoken={state.spoken}
              total={state.total}
              rate={state.rate}
              voice={state.voice}
              voices={catalogue?.voices ?? []}
              bookLanguage={state.bookLanguage}
              edgeError={catalogue?.edgeError ?? null}
              sleep={state.sleep}
              minimal={state.minimal}
              onView={setView}
              onClose={fold}
              onToggle={() => void sendSpeechControl("toggle")}
              onStep={(dir) => void sendSpeechControl(dir > 0 ? "next" : "prev")}
              onSkip={(dir) => void sendSpeechControl({ kind: "skip", dir })}
              onSeek={(at) => void sendSpeechControl({ kind: "seek", index: at })}
              onRate={(value) => void sendSpeechControl({ kind: "rate", value })}
              onVoice={(uri) => void sendSpeechControl({ kind: "voice", uri })}
              onSleep={(choice) => void sendSpeechControl({ kind: "sleep", choice })}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Nothing while the card is up — including the card's last 160ms, which
          is why this asks `holding` and not `cardUp`: the capsule comes back
          once the panel is gone, out of the place the panel was folded into. */}
      <AnimatePresence>
        {!holding && (
          <motion.div
            key="pill"
            className="absolute inset-x-1 bottom-1 flex justify-center"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING.panel}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0.1 } }
                : { opacity: 0, y: 4, transition: { duration: 0.12 } }
            }
          >
            <Pill
              // Wider than the in-app pill, because it carries two more controls:
              // the way back to the text and the fold-away below. The title keeps
              // the room it had before they were added.
              className="w-[468px]"
              dragHandle
              coverUrl={state.coverUrl}
              title={state.title}
              chapter={state.chapter}
              line={
                state.error ??
                (state.loading ? (
                  <LoadingBars />
                ) : (
                  <>{barClock(!state.playing, state.elapsed, state.remaining)}</>
                ))
              }
              percent={state.percent}
              status={state.playing ? "playing" : "paused"}
              // The cover and the title open the player *in this window*, which is
              // the whole point of the bar: a reader listening to a book while
              // working in another app should not have to bring the app up to
              // change the voice.
              onOpen={() => setExpanded(true)}
              openLabel="展开朗读播放器"
              onPrev={() => void sendSpeechControl("prev")}
              onToggle={() => void sendSpeechControl("toggle")}
              onNext={() => void sendSpeechControl("next")}
              onStop={() => void sendSpeechControl("stop")}
              trailing={
                <>
                  {/* The one thing the bar cannot do by itself: the voice is reading
                      a book that is not on screen anywhere, and this is how the
                      reader gets back to it — the window up, the reader on the page,
                      the sentence being spoken in the middle of it. */}
                  <Transport label="回到阅读" onClick={() => void sendSpeechControl("focus")}>
                    <BookOpenText size={14} weight="fill" />
                  </Transport>
                  <Transport label="收起悬浮条" onClick={() => void ipc.miniBarDismiss()}>
                    <CaretDown size={14} weight="bold" />
                  </Transport>
                </>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
