import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUDownLeft, MagnifyingGlass } from "@phosphor-icons/react";

import { scoreCommand, type Command, type Shortcut } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";
import { useCommandPalette } from "@/stores/command-palette";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassInput } from "@/components/glass/input";
import { cn } from "@/lib/cn";

interface Scored {
  command: Command;
  score: number;
}

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const session = useCommandPalette((s) => s.session);

  return (
    <GlassDialog
      open={open}
      onOpenChange={setOpen}
      title="命令面板"
      description="搜索动作、跳转视图、调整外观。"
      widthClass="w-[min(94vw,620px)]"
    >
      {/* Remount per open: the query and the selection reset without an effect. */}
      <PaletteBody key={session} onClose={() => setOpen(false)} />
    </GlassDialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const commands = useCommandStore((s) => s.commands);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus after Radix has mounted the dialog content.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  const results = useMemo<Scored[]>(() => {
    const scored: Scored[] = [];
    for (const command of commands) {
      if (command.isEnabled && !command.isEnabled()) continue;
      const s = scoreCommand(query, command);
      if (s == null) continue;
      scored.push({ command, score: s });
    }
    scored.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
    return scored.slice(0, 24);
  }, [commands, query]);

  const groups = useMemo(() => {
    const buckets = new Map<string, Scored[]>();
    for (const entry of results) {
      const bucket = buckets.get(entry.command.group) ?? [];
      bucket.push(entry);
      buckets.set(entry.command.group, bucket);
    }
    let cursor = 0;
    return Array.from(buckets, ([group, items]) => ({
      group,
      items: items.map((entry) => ({ entry, index: cursor++ })),
    }));
  }, [results]);

  function updateQuery(next: string) {
    setQuery(next);
    setActive(0);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[active];
      if (!target) return;
      onClose();
      void target.command.run();
    }
  }

  return (
    <div>
      <div className="glass mb-3 flex h-9 items-center gap-2 rounded-md px-2.5">
        <MagnifyingGlass size={16} className="text-text-2" />
        <GlassInput
          ref={inputRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={handleKey}
          placeholder="输入命令或搜索..."
          className="border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:bg-transparent"
        />
      </div>
      <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
        {results.length === 0 && (
          <div className="text-text-2 px-2 py-6 text-center text-sm">没有匹配的命令</div>
        )}
        {groups.map(({ group, items }) => (
          <section key={group} className="mb-3">
            <h3 className="text-text-3 px-2 pb-1 text-[11px] tracking-[0.14em] uppercase">
              {group}
            </h3>
            <ul>
              {items.map(({ entry, index }) => (
                <li key={entry.command.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      onClose();
                      void entry.command.run();
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left",
                      "transition-colors",
                      index === active
                        ? "bg-accent-soft text-text-1"
                        : "text-text-1 hover:bg-surface-1",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="text-text-2">{entry.command.icon}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{entry.command.title}</span>
                        {entry.command.description && (
                          <span className="text-text-2 block truncate text-[12px]">
                            {entry.command.description}
                          </span>
                        )}
                      </span>
                    </span>
                    {entry.command.shortcut?.[0] && (
                      <kbd className="text-text-3 font-mono text-[11px]">
                        {formatShortcut(entry.command.shortcut[0])}
                      </kbd>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <footer className="text-text-3 mt-3 flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1">
          <ArrowUDownLeft size={12} /> 回车执行
        </span>
        <span>↑↓ 选择 · Esc 关闭</span>
      </footer>
    </div>
  );
}

function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.mod) parts.push("⌘");
  if (shortcut.shift) parts.push("⇧");
  if (shortcut.alt) parts.push("⌥");
  parts.push(shortcut.key.toUpperCase());
  return parts.join(" ");
}
