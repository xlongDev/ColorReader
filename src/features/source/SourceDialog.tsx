import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUUpLeft, DownloadSimple, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import {
  useDeleteSource,
  useSaveSource,
  useSourceDownload,
  useSourceSearch,
  useSources,
} from "@/hooks/useSource";
import type { SourceRules } from "@/types/ipc";

const BLANK_SOURCE: SourceRules = {
  name: "新书源",
  baseUrl: "https://",
  search: {
    url: "/search?kw={{keyword}}",
    list: "$.data.list[*]",
    title: "$.name",
    author: "$.author",
    intro: "$.intro",
    cover: "$.cover",
    bookUrl: "$.book_id",
  },
  book: { title: "$.title", author: "$.author", intro: "$.intro", cover: "" },
  chapters: { list: "$.data.chapters[*]", title: "$.name", url: "$.url" },
  content: { paragraphs: "$.data.content" },
};

interface Editor {
  id: string | null;
  text: string;
}

export function SourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<"search" | "manage">("search");
  const [editing, setEditing] = useState<Editor | null>(null);

  if (!open) return null;

  return (
    <GlassDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          {view === "manage" ? "管理书源" : "在线找书"}
        </span>
      }
      description={
        view === "manage"
          ? "书源是一份 JSON 规则，描述如何调用一个网站的搜索、详情、章节和正文接口。"
          : "选一个书源，用书名或作者搜索，下载后自动进书架。"
      }
      widthClass="w-[min(94vw,560px)]"
    >
      {view === "search" ? (
        <SearchView onManage={() => setView("manage")} />
      ) : editing ? (
        <SourceEditor editor={editing} onBack={() => setEditing(null)} />
      ) : (
        <ManageView
          onNew={() => setEditing({ id: null, text: JSON.stringify(BLANK_SOURCE, null, 2) })}
          onEdit={(entry) => setEditing({ id: entry.id, text: JSON.stringify(entry.def, null, 2) })}
          onBack={() => setView("search")}
        />
      )}
    </GlassDialog>
  );
}

function SearchView({ onManage }: { onManage: () => void }) {
  const queryClient = useQueryClient();
  const sources = useSources();
  const [sourceId, setSourceId] = useState("");
  const [keyword, setKeyword] = useState("");

  const search = useSourceSearch();
  const { download, progress } = useSourceDownload();
  const [message, setMessage] = useState<string | null>(null);

  const list = sources.data ?? [];
  const activeId = sourceId || list[0]?.id || "";

  const runSearch = () => {
    if (!activeId) return;
    search.mutate({ sourceId: activeId, keyword }, { onSuccess: () => setMessage(null) });
  };

  const runDownload = (bookUrl: string) => {
    download.mutate(
      { sourceId: activeId, bookUrl },
      {
        onSuccess: (result) => {
          setMessage(
            result.duplicate ? `《${result.title}》已在书架上` : `《${result.title}》已加入书架`,
          );
          void queryClient.invalidateQueries({ queryKey: ["books"] });
        },
        onError: (error) => setMessage(String(error)),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          aria-label="选择书源"
          value={activeId}
          onChange={(event) => setSourceId(event.target.value)}
          className="border-hairline bg-surface-1 text-text-1 h-9 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none [&>option]:text-black"
        >
          {list.length === 0 && <option value="">还没有书源</option>}
          {list.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <GlassButton size="md" onClick={onManage}>
          管理
        </GlassButton>
      </div>

      <div className="flex items-center gap-2">
        <GlassInput
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch();
          }}
          placeholder="书名或作者"
          aria-label="搜索关键词"
        />
        <GlassButton
          variant="primary"
          size="md"
          disabled={!activeId || !keyword.trim() || search.isPending}
          onClick={runSearch}
        >
          <MagnifyingGlass size={14} /> 搜索
        </GlassButton>
      </div>

      {list.length === 0 && (
        <p className="text-text-3 py-6 text-center text-sm">
          先到「管理」里添加一个书源，再回来搜索。
        </p>
      )}

      {search.isError && (
        <p className="text-text-2 border-hairline bg-surface-1 rounded-xl border px-3 py-2 text-[12.5px]">
          {String(search.error)}
        </p>
      )}

      {search.data && search.data.length === 0 && (
        <p className="text-text-3 py-6 text-center text-sm">没有找到匹配的书。</p>
      )}

      <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {search.data?.map((book) => (
          <li
            key={book.url}
            className="border-hairline bg-surface-1 flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-text-1 truncate text-[13.5px] font-medium">
                {book.title}
                {book.author && <span className="text-text-3 ml-2 text-xs">{book.author}</span>}
              </p>
              {book.intro && (
                <p className="text-text-3 mt-1 line-clamp-2 text-[12px] leading-relaxed">
                  {book.intro}
                </p>
              )}
            </div>
            <GlassButton
              size="sm"
              disabled={download.isPending}
              onClick={() => runDownload(book.url)}
            >
              <DownloadSimple size={14} /> 下载
            </GlassButton>
          </li>
        ))}
      </ul>

      {(download.isPending || message) && (
        <p className="text-text-2 text-[12.5px]">
          {download.isPending && progress
            ? `正在下载 ${progress.done}/${progress.total}：${progress.chapter}`
            : message}
        </p>
      )}
    </div>
  );
}

function ManageView({
  onNew,
  onEdit,
  onBack,
}: {
  onNew: () => void;
  onEdit: (entry: { id: string; name: string; def: SourceRules }) => void;
  onBack: () => void;
}) {
  const sources = useSources();
  const deleteSource = useDeleteSource();

  const list = sources.data ?? [];

  return (
    <div className="space-y-3">
      <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
        {list.map((entry) => (
          <li
            key={entry.id}
            className="border-hairline bg-surface-1 flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
          >
            <button
              type="button"
              className="text-text-1 min-w-0 flex-1 truncate text-left text-[13.5px] font-medium"
              onClick={() => onEdit(entry)}
            >
              {entry.name}
            </button>
            <GlassButton
              size="sm"
              disabled={deleteSource.isPending}
              onClick={() => deleteSource.mutate(entry.id)}
            >
              <Trash size={14} />
            </GlassButton>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-2">
        <GlassButton size="md" onClick={onBack}>
          <ArrowUUpLeft size={14} /> 返回
        </GlassButton>
        <GlassButton variant="primary" size="md" onClick={onNew}>
          <Plus size={14} /> 新建书源
        </GlassButton>
      </div>
    </div>
  );
}

function SourceEditor({ editor, onBack }: { editor: Editor; onBack: () => void }) {
  const save = useSaveSource();
  const [text, setText] = useState(editor.text);
  const [error, setError] = useState<string | null>(null);

  const runSave = () => {
    let def: SourceRules;
    try {
      def = JSON.parse(text) as SourceRules;
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    save.mutate(
      { id: editor.id, def },
      { onSuccess: onBack, onError: (err) => setError(String(err)) },
    );
  };

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        aria-label="书源规则"
        className="border-hairline bg-surface-1 text-text-1 h-72 w-full rounded-xl border p-3 font-mono text-[12px] leading-relaxed outline-none"
      />
      {error && <p className="text-text-2 text-[12.5px] break-all">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <GlassButton size="md" onClick={onBack}>
          取消
        </GlassButton>
        <GlassButton variant="primary" size="md" disabled={save.isPending} onClick={runSave}>
          保存
        </GlassButton>
      </div>
    </div>
  );
}
