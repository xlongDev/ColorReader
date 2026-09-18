import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowSquareOut,
  BookOpen,
  MagnifyingGlass,
  Notebook,
  Trash,
  X,
} from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { SPRING, useMotion } from "@/lib/motion";
import { useBooks } from "@/hooks/useLibrary";
import {
  useAnnotationsByBook,
  useDeleteAnnotation,
  useSetAnnotationNote,
} from "@/hooks/useAnnotations";
import { AnnotationNote } from "@/features/reader/AnnotationNote";
import { EmptyState } from "@/components/common/EmptyState";
import { authorLine } from "@/features/library/format";
import {
  filterNotes,
  groupByBook,
  inkColor,
  tally,
  unitLabel,
  type BookNotes,
  type NoteEntry,
} from "@/features/notes/aggregate";
import type { BookQuery } from "@/types/ipc";

/**
 * Notes — the highlights the reader made *in books*, gathered in one place.
 *
 * This is a view, not a store. Every row is a row of the same `annotations`
 * table the reader writes to, on the same query key, so a note edited here is
 * the note the reader shows next time the book is opened, and vice versa —
 * there is no copy to fall out of step and no sync step to forget.
 *
 * The consequence worth knowing: deleting here deletes the highlight in the
 * book too, exactly as it does from the reader's own annotation list. There is
 * no undo on either surface.
 */

/** Recent-first, which is the order the page groups in: the book you were last
 *  in is the one whose notes you are most likely looking for. */
const SHELF_QUERY: BookQuery = { filter: "all", sort: "recentlyRead" };

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "noted", label: "有笔记" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

export function NotesPage() {
  const m = useMotion();
  const navigate = useNavigate();
  const books = useBooks(SHELF_QUERY);
  const bookIds = useMemo(() => (books.data ?? []).map((book) => book.id), [books.data]);
  const annotations = useAnnotationsByBook(bookIds);
  const { byBook } = annotations;

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");

  // Memoised on the query's own data rather than on `?? []`, which would be a
  // fresh array every render and re-group the whole shelf on each keystroke.
  const shelf = useMemo(() => books.data ?? [], [books.data]);
  const everything = useMemo(() => groupByBook(shelf, byBook), [shelf, byBook]);
  const shown = useMemo(
    () => filterNotes(everything, { query, onlyNoted: filter === "noted" }),
    [everything, query, filter],
  );

  // Both halves count. Until the shelf answers there are no ids to ask about,
  // so the annotation queries have not started and report themselves settled —
  // reading only their flag would flash "还没有标注" over a library that has
  // plenty, which is a lie the reader has no way to tell from the truth.
  const loading = books.isPending || annotations.loading;

  const total = tally(everything);
  const visible = tally(shown);
  const narrowed = query.trim() !== "" || filter !== "all";

  const open = useCallback(
    (entry: NoteEntry) => {
      navigate(`/reader?book=${entry.book.id}&annotation=${entry.annotation.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="px-8 pt-8 pb-6">
        <h1 className="text-text-1 text-2xl font-semibold tracking-tight">笔记</h1>
        <p className="text-text-2 mt-1.5 text-sm leading-relaxed">
          你在书里划过的句子，和写在旁边的想法。这里改动的那一份，就是书里的那一份。
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        <motion.div
          initial={m.reduce ? false : { opacity: 0, y: m.rise }}
          animate={{ opacity: 1, y: 0 }}
          transition={m.enter}
          className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl"
        >
          <Toolbar
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            total={total}
            visible={visible}
            narrowed={narrowed}
          />

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && everything.length === 0 ? (
              <p className="text-text-3 flex h-full items-center justify-center text-[13px]">
                正在读取标注…
              </p>
            ) : shown.length === 0 ? (
              <Board
                narrowed={narrowed}
                hasAny={total.highlights > 0}
                onClear={() => {
                  setQuery("");
                  setFilter("all");
                }}
              />
            ) : (
              <div className="pb-4">
                {shown.map((group) => (
                  <BookSection key={group.book.id} group={group} onOpen={open} />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function Toolbar({
  query,
  onQuery,
  filter,
  onFilter,
  total,
  visible,
  narrowed,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: FilterValue;
  onFilter: (value: FilterValue) => void;
  total: { highlights: number; notes: number };
  visible: { highlights: number; notes: number };
  narrowed: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="border-hairline flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <div className="relative min-w-[180px] flex-1">
        <MagnifyingGlass
          size={14}
          className="text-text-3 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索原文、笔记或书名"
          aria-label="搜索标注"
          className="border-hairline bg-surface-1 text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 h-8 w-full rounded-md border pr-8 pl-8 text-[13px] transition-colors focus-visible:outline-none"
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => onQuery("")}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Segmented control; the highlight is one element shared between the two
          cells, so the fill slides rather than cross-fading. The cells carry
          `aria-pressed` themselves — the shelf's layout switch does the same,
          and a `role="group"` wrapper on a `div` is not worth a `fieldset`. */}
      <div className="glass flex items-center rounded-full p-0.5">
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onFilter(option.value)}
              className={cn(
                "focus-visible:focus-ring relative flex h-7 items-center rounded-full px-3 text-[12.5px] transition-colors",
                active ? "text-text-1" : "text-text-3 hover:text-text-2",
              )}
            >
              {active && (
                <motion.span
                  layoutId="notes-filter-pill"
                  className="bg-surface-3 shadow-glass absolute inset-0 rounded-full"
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>

      <p className="text-text-3 shrink-0 text-[12px]">
        {narrowed
          ? `${visible.highlights} / ${total.highlights} 条`
          : `${total.highlights} 条标注 · ${total.notes} 条笔记`}
      </p>

      {/* A resident live region carrying one sentence, rather than a region
          inserted with its text already in it: screen readers announce changes
          to a region they already know about far more reliably than they
          announce a region that arrived mid-sentence. */}
      <output className="sr-only">
        {narrowed
          ? `筛选后 ${visible.highlights} 条标注，其中 ${visible.notes} 条写了笔记`
          : `共 ${total.highlights} 条标注，其中 ${total.notes} 条写了笔记`}
      </output>
    </div>
  );
}

/** One book's highlights, under a header that names the book. */
function BookSection({ group, onOpen }: { group: BookNotes; onOpen: (entry: NoteEntry) => void }) {
  const { book, entries } = group;
  return (
    <section className="px-4 pt-4 first:pt-3">
      <header className="flex items-center gap-3 px-1 pb-2">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="border-hairline h-9 w-[27px] shrink-0 rounded-[3px] border object-cover"
          />
        ) : (
          <span className="border-hairline text-text-3 flex h-9 w-[27px] shrink-0 items-center justify-center rounded-[3px] border">
            <BookOpen size={13} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-text-1 truncate text-[13.5px] font-medium">{book.title}</h2>
          <p className="text-text-3 truncate text-[11.5px]">{authorLine(book)}</p>
        </div>
        <span className="text-text-3 shrink-0 text-[11.5px]">{entries.length} 条</span>
      </header>

      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <NoteRow key={entry.annotation.id} entry={entry} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One highlight: the passage, where it lives, and the note hanging off it.
 *
 * The row owns its own mutations rather than taking them as props, because the
 * cache patch a note write performs is keyed by book — a single shared mutation
 * would have to be re-pointed at a different book for every row.
 */
function NoteRow({ entry, onOpen }: { entry: NoteEntry; onOpen: (entry: NoteEntry) => void }) {
  const { annotation, book } = entry;
  const setNote = useSetAnnotationNote(book.id);
  const remove = useDeleteAnnotation(book.id);
  const busy = setNote.isPending || remove.isPending;

  return (
    <li className="hover:bg-surface-1 flex gap-2.5 rounded-lg px-2 py-2.5 transition-colors">
      {/* The ink the passage carries in the book, so a row is recognisable as
          the highlight it is rather than as a generic quotation. */}
      <span
        aria-hidden
        className="w-[3px] shrink-0 self-stretch rounded-full"
        style={{ background: inkColor(annotation) }}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(entry)}
          title="在书中打开"
          className="focus-visible:focus-ring text-text-1 block w-full rounded-md text-left text-[13px] leading-relaxed"
        >
          {annotation.text}
        </button>

        <div className="mt-1 flex items-center gap-1">
          <p className="text-text-3 flex-1 text-[11px]">
            第 {annotation.chapterIdx + 1} {unitLabel(book.format)}
          </p>
          <button
            type="button"
            aria-label="在书中打开"
            title="在书中打开"
            onClick={() => onOpen(entry)}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 rounded p-1 transition-colors"
          >
            <ArrowSquareOut size={13} />
          </button>
          <button
            type="button"
            aria-label="删除标注"
            title="删除标注"
            disabled={busy}
            onClick={() => remove.mutate(annotation.id)}
            className="focus-visible:focus-ring text-text-3 hover:text-danger rounded p-1 transition-colors disabled:opacity-50"
          >
            <Trash size={13} />
          </button>
        </div>

        <div className="mt-1.5">
          <AnnotationNote
            note={annotation.note}
            disabled={busy}
            onSave={(note) => setNote.mutate({ id: annotation.id, note })}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * Nothing to show — either because nothing was ever marked, or because the
 * filter excluded everything. The two want different sentences: one is a
 * starting point, the other is a dead end with a way out of it.
 */
function Board({
  narrowed,
  hasAny,
  onClear,
}: {
  narrowed: boolean;
  hasAny: boolean;
  onClear: () => void;
}) {
  if (narrowed && hasAny) {
    return (
      <EmptyState
        icon={<MagnifyingGlass size={22} weight="duotone" />}
        title="没有匹配的标注"
        description="换一个词试试，或者把筛选放宽。"
        action={
          <button
            type="button"
            onClick={onClear}
            className="press focus-visible:focus-ring border-hairline text-text-2 hover:text-text-1 rounded-md border px-3.5 py-1.5 text-[13px] transition-colors"
          >
            清空筛选
          </button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<Notebook size={22} weight="duotone" />}
      title="还没有标注"
      description="在阅读器里选中正文就能划线和写笔记，它们会按书归到这里。"
    />
  );
}
