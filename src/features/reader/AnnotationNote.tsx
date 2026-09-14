import { useEffect, useRef, useState } from "react";
import { NotePencil } from "@phosphor-icons/react";

/**
 * The reader's own note hanging off a highlight.
 *
 * Two states and no mode flag to keep in sync: no draft means "showing", a
 * draft means "editing". Committing compares against the saved note, so
 * opening one and closing it again costs no round trip, and emptying the field
 * clears the note instead of storing an empty string (the backend folds blanks
 * to `NULL`, so "has a note" stays a single test).
 */
export function AnnotationNote({
  note,
  disabled,
  onSave,
}: {
  /** The saved note, or `null` when there is none. */
  note: string | null;
  /** True while an edit is already in flight for this list. */
  disabled?: boolean;
  /** Receives the trimmed note, or `null` to clear it. */
  onSave: (note: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape rewinds and closes; this keeps the blur that closing triggers from
  // committing the draft it just threw away.
  const rewound = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;

  // Focus the field as it appears. The reader asked for it by clicking, so the
  // caret should already be in it — but not through `autoFocus`, which the a11y
  // rule bans for the page-load case it cannot tell this apart from.
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  if (draft === null) {
    return note === null ? (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setDraft("")}
        className="text-text-3 hover:text-text-1 inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-50"
      >
        <NotePencil size={12} />
        添加笔记
      </button>
    ) : (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setDraft(note)}
        title="点击编辑笔记"
        className="border-hairline text-text-2 hover:text-text-1 block w-full border-l pl-2.5 text-left text-[12.5px] leading-relaxed whitespace-pre-wrap transition-colors disabled:opacity-50"
      >
        {note}
      </button>
    );
  }

  /**
   * The one commit path: losing focus and ⌘/Ctrl+Enter both end up here. Esc
   * deliberately does not — it closes through `rewound` above.
   */
  const commit = () => {
    const next = draft.trim();
    setDraft(null);
    if (next !== (note ?? "").trim()) onSave(next === "" ? null : next);
  };

  return (
    <textarea
      ref={field}
      aria-label="标注笔记"
      rows={2}
      value={draft}
      disabled={disabled}
      placeholder="写下你的想法"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (rewound.current) {
          rewound.current = false;
          setDraft(null);
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          rewound.current = true;
          event.currentTarget.blur();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.currentTarget.blur();
        }
      }}
      className="border-hairline bg-surface-1 text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 w-full resize-none rounded-md border px-2.5 py-2 text-[12.5px] leading-relaxed transition-colors focus-visible:outline-none"
    />
  );
}
