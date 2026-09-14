/**
 * The Markdown subset the AI panels emit, rendered as React elements.
 *
 * A general parser is not worth owning here. The guide's own prompt fixes the
 * shape (headings, bullet lists, bold), and the answer arrives one delta at a
 * time, so whatever renders it has to render half-finished input on every
 * frame. This one does: an unterminated `**` stays literal text instead of
 * swallowing the rest of the answer, and a blank line just closes the block
 * before it.
 *
 * Output is elements, never `dangerouslySetInnerHTML`: model output is text and
 * must stay text.
 */

import type { ReactNode } from "react";

/** One list item. `order` is its position in the list, and it is what React
 * keys on: while an answer streams, an item's *text* grows but its position
 * does not, so keying on the text would remount the row on every delta. */
export interface ListItem {
  order: number;
  text: string;
}

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

/** Characters that start a block, matched once per line. */
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** Splits Markdown into blocks. Pure, and never throws on partial input. */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "").length,
        text: (heading[2] ?? "").trim(),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      closeParagraph();
      const isOrdered = ordered !== null;
      // A change of marker starts a new list rather than merging numbering
      // into bullets.
      if (list && list.ordered !== isOrdered) closeList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push({
        order: list.items.length,
        text: (bullet?.[1] ?? ordered?.[1] ?? "").trim(),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      blocks.push({ kind: "quote", text: (quote[1] ?? "").trim() });
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeParagraph();
  closeList();
  return blocks;
}

/** `**bold**` and `` `code` ``, left to right. Unterminated markers never match. */
function inline(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(/\*\*[^*]+\*\*|`[^`]+`/g)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const tokenKey = `${key}-${index++}`;
    parts.push(
      token.startsWith("**") ? (
        <strong key={tokenKey} className="font-medium">
          {token.slice(2, -2)}
        </strong>
      ) : (
        <code key={tokenKey} className="bg-surface-1 rounded px-1 py-px text-[12px]">
          {token.slice(1, -1)}
        </code>
      ),
    );
    cursor = match.index + token.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function blockNode(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <p
          key={key}
          className={
            // A heading needs more air above it than below, or a section reads
            // as another line of the paragraph that preceded it.
            block.level <= 2
              ? "text-text-1 pt-1.5 text-[13.5px] leading-snug font-medium"
              : "text-text-2 pt-1 text-[12.5px] leading-snug font-medium"
          }
        >
          {inline(block.text, key)}
        </p>
      );
    case "list":
      return (
        <ul key={key} className="space-y-1.5">
          {block.items.map((item) => (
            <li key={item.order} className="text-text-1 flex gap-2 text-[13px] leading-relaxed">
              {block.ordered ? (
                <span className="text-text-3 w-4 shrink-0 text-right tabular-nums">
                  {item.order + 1}.
                </span>
              ) : (
                <span aria-hidden className="bg-text-3 mt-[9px] size-1 shrink-0 rounded-full" />
              )}
              <span className="min-w-0">{inline(item.text, `${key}-${item.order}`)}</span>
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <p
          key={key}
          className="border-hairline text-text-2 border-l-2 pl-3 text-[12.5px] leading-relaxed"
        >
          {inline(block.text, key)}
        </p>
      );
    case "paragraph":
      return (
        <p key={key} className="text-text-1 text-[13px] leading-relaxed">
          {inline(block.text, key)}
        </p>
      );
  }
}

/** Renders streamed Markdown as a stack of blocks. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {parseBlocks(text).map((block, index) => blockNode(block, `b${index}`))}
    </div>
  );
}
