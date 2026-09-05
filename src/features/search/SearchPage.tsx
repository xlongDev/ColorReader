import { useNavigate } from "react-router-dom";
import { SearchPanel } from "@/features/search/SearchPanel";
import type { SearchHit } from "@/types/ipc";

/** Library-wide search: every hit opens the reader at the matching chapter. */
export function SearchPage() {
  const navigate = useNavigate();

  const onPick = (hit: SearchHit, needle: string) => {
    const params = new URLSearchParams({
      book: hit.bookId,
      chapter: String(hit.chapterIdx),
      q: needle,
      at: String(hit.offset),
    });
    navigate(`/reader?${params.toString()}`);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-8 pt-8 pb-6">
        <h1 className="text-text-1 text-2xl font-semibold tracking-tight">全文检索</h1>
        <p className="text-text-2 mt-1 text-sm">在所有已导入的书籍正文里查找，结果按相关度排序。</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl pt-4">
          <SearchPanel onPick={onPick} />
        </div>
      </div>
    </div>
  );
}
