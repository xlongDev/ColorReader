import type { ReactNode } from "react";
import { ArrowClockwise, BookOpen } from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { describeError } from "@/lib/log";

interface QueryErrorProps {
  /** The rejection from the read query. Rendered, folded, in the diagnostic. */
  error: unknown;
  /** The one action that can help: re-ask the query. Omit for a
   *  diagnostic-only state (no retry button). */
  onRetry?: () => void;
  /** Glyph above the title. Defaults to a book; pass a surface icon
   *  (Notebook, ChartLineUp, MagnifyingGlass) so the state reads as that page. */
  icon?: ReactNode;
  /** Short heading. Defaults to "暂时打不开" — the description carries the cause. */
  title?: string;
  /** The sentence a reader needs first. Keep it about the action, not the
   *  exception; the exception lives in the folded diagnostic. */
  description?: string;
  className?: string;
}

/**
 * One read-failure surface for the whole app, extracted from the shelf's P1-9
 * empty state.
 *
 * Order matters: a human sentence the reader can act on first, the retry
 * second, and the raw exception folded into a `<details>` that is the only
 * thing on the screen a bug report can quote. Write failures stay on the
 * shared mutation toast (see `app/providers.tsx`); this is deliberately NOT a
 * global Query error handler — a quiet empty result (e.g. "this book has no
 * annotations") must never become a toast.
 */
export function QueryError({
  error,
  onRetry,
  icon,
  title = "暂时打不开",
  description = "这次没有读出来。先重试一次；如果还是不行，多半是本地的数据库或书籍文件出了问题。",
  className,
}: QueryErrorProps) {
  const { name, message } = describeError(error);
  return (
    <EmptyState
      className={className}
      icon={icon ?? <BookOpen size={26} weight="duotone" />}
      title={title}
      description={description}
      action={
        <>
          {onRetry && (
            <GlassButton variant="primary" size="md" onClick={onRetry}>
              <ArrowClockwise size={14} /> 重试
            </GlassButton>
          )}
          <details className="mt-4">
            <summary className="text-text-3 cursor-pointer text-xs select-none">诊断信息</summary>
            {/* Left-aligned lines inside a centred block: an exception is a
                sentence with a path in it, and a wrapped one centred line by
                line is the one thing that makes it hard to read. */}
            <p className="text-text-3 mx-auto mt-2 max-w-[46ch] text-left font-mono text-[11.5px] leading-relaxed break-all">
              {name}: {message}
            </p>
          </details>
        </>
      }
    />
  );
}
