import { useCallback, type RefObject } from "react";
import { useNavigate } from "react-router-dom";

import { paragraphAt } from "@/features/reader/selection";
import type { RagHit, SearchHit } from "@/types/ipc";

/**
 * Landing the reader on a position named by a search hit or an AI citation.
 *
 * One rule, and it is the reason these three are together rather than spread
 * across the panels that own the buttons:
 *
 * - a position in the chapter **already on screen** can be scrolled to now;
 * - a position in **another chapter** cannot — that chapter has not been
 *   fetched, let alone laid out — so it is parked in the spine's pending slot
 *   and `applyPending` scrolls there once the body appears;
 * - a citation into **another book** is not a jump at all, it is a navigation.
 *
 * The two slots this writes into (`goTo` and `pendingFocus`) belong to the
 * reader's navigation, not to this, so they come in as arguments. That is the
 * whole coupling: this hook decides *which* of the three cases applies and
 * hands the position over, and the spine owns the moving.
 */

export interface HitJumpsOptions {
  /** The book the reader is on; a citation for another one opens that book. */
  bookId: string;
  chapterIdx: number;
  /** Paragraphs of the chapter on screen, or `null` while it loads. */
  paragraphs: string[] | null | undefined;
  /** The spine's navigation. */
  goTo: (idx: number) => void;
  /**
   * The spine's pending-offset slot, as a setter rather than the ref itself.
   *
   * The offset is read by `applyPending` once the chapter it names has
   * rendered, and this hook is the only thing that ever writes it — but a
   * hook must not mutate a value it does not own, so the owner hands over the
   * write instead of the box.
   */
  setPendingFocus: (offset: number | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export interface HitJumpsControls {
  /** Reveals a search hit: here, or after the chapter it names lands. */
  pick: (hit: SearchHit) => void;
  /** Follows a RAG citation: here, or in the book it names. */
  follow: (hit: RagHit) => void;
}

export function useHitJumps({
  bookId,
  chapterIdx,
  paragraphs,
  goTo,
  setPendingFocus,
  scrollRef,
}: HitJumpsOptions): HitJumpsControls {
  const navigate = useNavigate();

  /** Reveals a character offset of the chapter already on screen. */
  const focusOffset = useCallback(
    (offset: number) => {
      const el = scrollRef.current;
      if (!paragraphs || !el) return;
      const target = paragraphAt(paragraphs, offset);
      el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
    },
    [paragraphs, scrollRef],
  );

  const pick = useCallback(
    (hit: SearchHit) => {
      if (hit.chapterIdx === chapterIdx) {
        focusOffset(hit.offset);
        return;
      }
      // Wait for the target chapter to render before scrolling to the match.
      setPendingFocus(hit.offset);
      goTo(hit.chapterIdx);
    },
    [chapterIdx, focusOffset, goTo, setPendingFocus],
  );

  const follow = useCallback(
    (hit: RagHit) => {
      if (hit.bookId !== bookId) {
        navigate(`/reader?book=${hit.bookId}&chapter=${hit.chapterIdx}&at=${hit.startChar}`);
        return;
      }
      if (hit.chapterIdx === chapterIdx) {
        focusOffset(hit.startChar);
        return;
      }
      setPendingFocus(hit.startChar);
      goTo(hit.chapterIdx);
    },
    [bookId, chapterIdx, focusOffset, goTo, navigate, setPendingFocus],
  );

  return { pick, follow };
}
