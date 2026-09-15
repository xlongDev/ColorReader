import type { BookSummary, ChapterContent, ChapterMeta, LibraryStats } from "@/types/ipc";

/**
 * Sample content for `pnpm dev` in a browser.
 *
 * The desktop app is the only thing that ships, and `isDesktopRuntime` is false
 * in a browser — so every reader hook normally short-circuits to an empty
 * result and the UI shows its honest "nothing here yet" state. That is right
 * for a user, but it makes the reading surface impossible to look at without
 * building the app, let alone to check a change against.
 *
 * With `?demo=1` those hooks answer from here instead. Two properties matter:
 *
 * - **It cannot reach the shipped app.** Every call site is guarded by
 *   `!isDesktopRuntime`, so in Tauri this module is unreachable.
 * - **It is off by default.** Without the parameter the browser build behaves
 *   exactly as it did before.
 */

export function demoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

/** A cover drawn as an SVG data URL, so the fixture needs no assets. */
function cover(index: number, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="300" height="400" fill="url(#g)"/>
    <circle cx="${70 + index * 30}" cy="${110 + index * 20}" r="${60 + index * 8}" fill="rgba(255,255,255,0.14)"/>
    <text x="30" y="350" fill="rgba(255,255,255,0.92)" font-size="54" font-family="sans-serif">${index + 1}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const PALETTES: [string, string][] = [
  ["#4c6ef5", "#f06595"],
  ["#37b24d", "#1c7ed6"],
  ["#9c36b5", "#0c8599"],
];

const TITLES = ["我们为什么会生病", "金色梦乡", "长日将尽"];
const AUTHORS = [["伦道夫·尼斯", "乔治·威廉斯"], ["伊坂幸太郎"], ["石黑一雄"]];

export const demoBooks: BookSummary[] = TITLES.map((title, index) => ({
  id: `demo-${index + 1}`,
  title,
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  // Plain text on purpose. The reader treats this as the prose path — no
  // foliate to load, no pdf.js page to render — so the demo renders straight
  // off `demoChapter` without anything else to mock.
  format: "txt",
  fileSize: 4_100_000 + index * 800_000,
  coverUrl: cover(index, PALETTES[index]![0], PALETTES[index]![1]),
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: index === 0 ? 0.18 : index === 1 ? 0.62 : 0,
  location: null,
  favorite: index === 0,
  authors: AUTHORS[index]!,
  tags: index === 1 ? ["小说", "悬疑"] : [],
})) as unknown as BookSummary[];

export const demoLibraryStats: LibraryStats = {
  total: demoBooks.length,
  favorites: 1,
  reading: 2,
  finished: 0,
} as unknown as LibraryStats;

const CHAPTER_TITLES = [
  "第一章 疾病的谜题",
  "第二章 防御与修复",
  "第三章 演化的遗留",
  "第四章 现代环境",
];

/** Enough body to scroll, paginate and select against. */
const PARAGRAPHS = [
  "身体是一台被反复修补过的机器。演化并不设计，它只保留此刻还能留下的东西，所以每一处精妙旁边都躺着一处将就。",
  "咳嗽、发烧、呕吐，这些让人难受的反应大多是防御本身，而不是疾病。压掉它们往往是在帮倒忙。",
  "为什么自然选择没有把衰老剔除掉？因为选择在繁殖之后就放手了，晚年是一段没有选择压力的时光，于是损伤在那里慢慢堆积。",
  "我们的基因来自一个食物稀缺、寄生虫遍地的世界，如今坐在一个热量过剩、几乎无菌的世界里，错位本身就是病。",
  "医学擅长处理近因——哪一种细菌、哪一条通路；演化医学追问远因——为什么这套设计会被留下。两把钥匙开两把锁。",
  "理解这一点并不会立刻治好什么病，但它会改变提问的方式，而提问的方式决定了找得到什么答案。",
];

export const demoToc: ChapterMeta[] = CHAPTER_TITLES.map((title, idx) => ({
  idx,
  title,
  chars: PARAGRAPHS.join("").length,
}));

export function demoChapter(idx: number): ChapterContent | null {
  const title = CHAPTER_TITLES[idx];
  if (title === undefined) return null;
  return { idx, title, paragraphs: PARAGRAPHS };
}
