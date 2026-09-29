/**
 * A book's own title, cut down to what a row can hold.
 *
 * EPUB metadata routinely merges a title and its subtitle into one string, and
 * every surface that printed a title was printing all of it: the shelf tile,
 * the continue-reading card, the notes header, the stats ranking, the command
 * palette. The worst of them ran three lines long and dwarfed the passage it
 * was labelling —
 *
 *   「认知觉醒: 开启自我改变的原动力 (当你认知觉醒, 何惧焦虑迷茫! 畅销书《反本能》作者卫蓝激赏力荐!)」
 *
 * — and on the shelf a CSS `truncate` then cut it at whatever the tile's width
 * happened to be, which is the same string with an arbitrary ending.
 *
 * Three rules, in order, each only firing if the one before it left too much:
 *
 *   1. Everything before the first colon is the main title. Only when that
 *      leaves two characters or more — a one-letter prefix is a typo in the
 *      metadata, not a title worth keeping.
 *   2. A **long** parenthetical at the end goes: 「韭菜的自我修养(李笑来首次公开
 *      投资原则)」. Short ones stay, because they are the one thing telling
 *      three otherwise identical books apart — 「你不知道的 JavaScript（上卷）」,
 *      （中卷）, （下卷）are three books on one shelf, and 「刺杀骑士团长（第一部）」
 *      is not 「第二部」.
 *   3. Still too long? Cut at `max` and say so with an ellipsis.
 *
 * Callers keep the full string for the `title` attribute and for accessible
 * names; this is only what gets painted.
 */
export function displayTitle(title: string, max = 20): string {
  const colon = title.search(/[:：]/);
  let main = (colon >= 2 ? title.slice(0, colon) : title).trim();

  if (main.length > max) {
    const trimmed = main.replace(/[（(【][^（()）【】]{6,}[）)】]\s*$/, "").trim();
    if (trimmed.length > 0) main = trimmed;
  }

  return main.length > max ? `${main.slice(0, max)}…` : main;
}
