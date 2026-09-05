import { useMemo, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

import { GlassInput } from "@/components/glass/input";
import { hitLocation, parseSnippet } from "@/features/search/snippet";
import { useSearch } from "@/hooks/useSearch";
import type { SearchHit } from "@/types/ipc";

interface SearchPanelProps {
  /** `null` searches every book; an id scopes the search to one book. */
  bookId?: string | null;
  /** `needle` is handed back so the reader can highlight what was searched. */
  onPick: (hit: SearchHit, needle: string) => void;
}

/** Input plus hit list. Fills whatever container it is placed in. */
export function SearchPanel({ bookId = null, onPick }: SearchPanelProps) {
  const [needle, setNeedle] = useState("");
  const query = useSearch(needle, bookId);
  const trimmed = needle.trim();

  // Keys are built here rather than in the JSX so no list uses a raw index.
  const rows = useMemo(
    () =>
      (query.data ?? []).map((hit, index) => ({
        hit,
        key: `${hit.bookId}:${hit.chapterIdx}:${hit.offset}:${index}`,
        parts: parseSnippet(hit.snippet).map((part, partIndex) => ({
          text: part.text,
          matched: part.matched,
          key: `${index}:${partIndex}`,
        })),
      })),
    [query.data],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-3">
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <GlassInput
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder="搜索正文"
            aria-label="搜索正文"
            className="pr-8 pl-8"
          />
          {needle.length > 0 && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setNeedle("")}
              className="text-text-3 hover:text-text-1 absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {trimmed.length === 0 ? (
          <p className="text-text-3 text-[13px] leading-relaxed">
            输入关键词，
            {bookId === null ? "在所有已导入的书籍正文里查找" : "在当前这本书的正文里查找"}
            。点击结果直接跳到那一章。
          </p>
        ) : query.isPending ? (
          <p className="text-text-3 text-[13px]">正在检索…</p>
        ) : query.isError ? (
          <p className="text-danger text-[13px] leading-relaxed">检索失败：{String(query.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-text-3 text-[13px] leading-relaxed">没有找到「{trimmed}」。</p>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ hit, key, parts }) => (
              <li key={key} className="border-hairline border-b pb-3 last:border-0 last:pb-0">
                <button
                  type="button"
                  onClick={() => onPick(hit, trimmed)}
                  className="hover:bg-surface-1 -mx-1 w-full rounded-md px-1 py-0.5 text-left transition-colors"
                >
                  <p className="text-text-3 text-xs">{hitLocation(hit, bookId !== null)}</p>
                  <p className="text-text-1 mt-1 text-[13px] leading-relaxed">
                    {parts.map((part) =>
                      part.matched ? (
                        <mark key={part.key} className="bg-accent-soft rounded-[2px] text-inherit">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={part.key}>{part.text}</span>
                      ),
                    )}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
