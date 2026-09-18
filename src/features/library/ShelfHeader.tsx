import { AnimatePresence, motion } from "motion/react";
import { FilePlus, Globe, Highlighter, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
import { greeting, type LibraryFilter } from "@/features/library/shelfQuery";

/**
 * The shelf heading: greeting, the filter's own title, and the three ways a
 * book arrives.
 *
 * 书库 / 最近 / 收藏 / 标签 are one page with four filters — the shell keeps
 * them mounted, so changing filter has nowhere else to show itself. The heading
 * steps out and the new one rises into its place, while the grid reflows
 * underneath: the incoming cards glide, the outgoing ones shrink away.
 *
 * Only the heading moves. The buttons beside it are part of the same gesture
 * but are pinned right by `justify-between` and must not be re-mounted out
 * from under a click — which is also why `popLayout` (the leaving heading goes
 * out of flow) is safe here.
 */
export function ShelfHeader({
  filter,
  meta,
  now,
  importing,
  webNotice,
  onDismissNotice,
  onClippings,
  onSource,
  onImport,
}: {
  filter: LibraryFilter;
  meta: { title: string; subtitle: string };
  now: Date;
  importing: boolean;
  webNotice: boolean;
  onDismissNotice: () => void;
  onClippings: () => void;
  onSource: () => void;
  onImport: () => void;
}) {
  const m = useMotion();
  return (
    <header className="px-8 pt-8 pb-6">
      <p className="text-text-2 text-sm">{greeting(now)}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={filter}
            initial={{ opacity: 0, y: m.reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : -8 }}
            transition={{ duration: m.reduce ? 0 : DURATION.fast, ease: EASE_OUT }}
          >
            <h1 className="text-text-1 text-2xl font-semibold tracking-tight">{meta.title}</h1>
            <p className="text-text-2 mt-1 text-sm">{meta.subtitle}</p>
          </motion.div>
        </AnimatePresence>
        <div className="flex items-center gap-2">
          <GlassButton size="md" onClick={onClippings}>
            <Highlighter size={15} /> 导入摘录
          </GlassButton>
          <GlassButton size="md" onClick={onSource}>
            <Globe size={15} /> 在线找书
          </GlassButton>
          <GlassButton variant="primary" size="md" disabled={importing} onClick={onImport}>
            <FilePlus size={15} /> 导入书籍
          </GlassButton>
        </div>
      </div>
      <AnimatePresence>
        {webNotice && (
          <motion.div
            initial={{ opacity: 0, y: m.reduce ? 0 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : -6 }}
            transition={{ duration: m.reduce ? 0 : DURATION.base }}
            className="border-hairline glass-2 mt-4 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5"
          >
            <p className="text-text-2 text-sm">
              网页版仅用于界面预览，导入书籍需要下载桌面端应用（阅读数据保存在本机）。
            </p>
            <button
              type="button"
              aria-label="关闭提示"
              className="text-text-3 hover:text-text-1 shrink-0 transition-colors"
              onClick={onDismissNotice}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
