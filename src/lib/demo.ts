import type {
  Annotation,
  BookSummary,
  ChapterContent,
  ChapterMeta,
  LibraryStats,
} from "@/types/ipc";

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

/**
 * How many tiles the sample shelf shows.
 *
 * Three read the layout fine, but a real library is a few hundred books and the
 * shelf's per-card entrance is charged per card — so a three-tile shelf cannot
 * show what returning from the reader costs. `?demo=1&books=84` sizes it for a
 * measurement; without the parameter the fixture is exactly what it always was.
 */
function shelfSize(): number {
  if (typeof window === "undefined") return TITLES.length;
  const asked = Number(new URLSearchParams(window.location.search).get("books"));
  return Number.isFinite(asked) && asked > TITLES.length ? Math.min(asked, 500) : TITLES.length;
}

/**
 * `?demo=1&epub=1` also puts a real EPUB on the sample shelf.
 *
 * The three samples above are plain text, which means the browser build never
 * loads foliate — and foliate is where a Kindle-style book's page number comes
 * from (a section's bytes, not anything the host can measure). Every page-number
 * defect a reader reported landed in exactly that gap: the suite could pass
 * while a real EPUB printed "1 / 1 页" on every page.
 *
 * Opt-in rather than always on: the tile would otherwise change the shelf every
 * other spec counts and clicks through. Built by
 * `scripts/generate-demo-epub.py`, served from `public/demo/`.
 */
function epubEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("epub") === "1";
}

/** The fixture EPUB's book id, so `demoEpubBytes` knows what it can answer. */
const EPUB_ID = "demo-epub";

const COUNT = shelfSize();

const shelf: BookSummary[] = Array.from({ length: COUNT }, (_, index) => ({
  id: `demo-${index + 1}`,
  // Beyond the three samples the shelf repeats them, numbered, so a locator that
  // names a book still names exactly one tile.
  title:
    index < TITLES.length
      ? TITLES[index]!
      : `${TITLES[index % TITLES.length]!} ${Math.floor(index / TITLES.length) + 1}`,
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  // Plain text on purpose. The reader treats this as the prose path — no
  // foliate to load, no pdf.js page to render — so the demo renders straight
  // off `demoChapter` without anything else to mock.
  format: "txt",
  fileSize: 4_100_000 + index * 800_000,
  coverUrl: cover(
    index,
    PALETTES[index % PALETTES.length]![0],
    PALETTES[index % PALETTES.length]![1],
  ),
  addedAt: 0,
  updatedAt: 0,
  // Two of the three samples carry a `lastReadAt` so the shelf's "continue
  // reading" card has something to point at on `?demo=1`. demo-2 is the
  // more recent of the two — so it, not the first book with progress, is
  // what the card surfaces. `null` for the rest (the duplicates beyond the
  // first three) keeps the card pointing at a single book.
  lastReadAt: index === 0 ? 100 : index === 1 ? 200 : null,
  progress: index === 0 ? 0.18 : index === 1 ? 0.62 : 0,
  location: null,
  favorite: index === 0,
  authors: AUTHORS[index % AUTHORS.length]!,
  tags: index === 1 ? ["小说", "悬疑"] : [],
})) as unknown as BookSummary[];

const epubBook: BookSummary = {
  id: EPUB_ID,
  title: "页码样书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 19_546,
  coverUrl: cover(3, PALETTES[0]![0], PALETTES[1]![1]),
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: 0,
  location: null,
  favorite: false,
  authors: ["样书"],
  tags: [],
} as unknown as BookSummary;

export const demoBooks: BookSummary[] = [...shelf, ...(epubEnabled() ? [epubBook] : [])];

/**
 * The fixture EPUB's bytes, for the reader's foliate path.
 *
 * In the app the book comes over IPC (or streams over the ColorReader
 * protocol); a browser has no backend to read a file from, so the fixture
 * serves one from `public/` instead. `null` for every other book — the caller
 * falls through to the real load path, which in a browser is what it always
 * was.
 */
export async function demoEpubBytes(bookId: string): Promise<ArrayBuffer | null> {
  if (bookId !== EPUB_ID) return null;
  const response = await fetch("/demo/page-numbers.epub");
  if (!response.ok) throw new Error(`样书 EPUB 取不到：HTTP ${response.status}`);
  return response.arrayBuffer();
}

export const demoLibraryStats: LibraryStats = {
  total: demoBooks.length,
  favorites: 1,
  reading: 2,
  finished: 0,
} as unknown as LibraryStats;

/**
 * Sample highlights, so the notes surface has something to aggregate.
 *
 * The notes page is *made of* other books' highlights; with an empty store it
 * could only ever render its empty state, and a browser dev session could not
 * tell a working aggregation from a broken one. Two books carry samples on
 * purpose — one with a note written and one without — because "全部 / 有笔记"
 * is the filter the page exists to offer, and a single book could not show it
 * doing anything.
 *
 * Unlike `demoBooks` this is mutable: a note edited on the page has to survive
 * the round trip through the query cache, or the surface reads as broken. The
 * fixtures are handed out as copies so a caller cannot edit them in place.
 */
const demoAnnotations: Annotation[] = [
  {
    id: "demo-a1",
    bookId: "demo-1",
    chapterIdx: 0,
    startChar: 0,
    endChar: 47,
    text: "身体是一台被反复修补过的机器。演化并不设计，它只保留此刻还能留下的东西。",
    cfi: null,
    color: "#ffd12e",
    style: "highlight",
    note: "全书的主线：把「设计」换成「修补」，很多奇怪的症状就说得通了。",
    createdAt: 1_700_000_100_000,
  },
  {
    id: "demo-a2",
    bookId: "demo-1",
    chapterIdx: 1,
    startChar: 120,
    endChar: 162,
    text: "咳嗽、发烧、呕吐，这些让人难受的反应大多是防御本身，而不是疾病。",
    cfi: null,
    color: "#f76f6f",
    style: "highlight",
    note: null,
    createdAt: 1_700_000_200_000,
  },
  {
    id: "demo-a3",
    bookId: "demo-1",
    chapterIdx: 2,
    startChar: 240,
    endChar: 291,
    text: "为什么自然选择没有把衰老剔除掉？因为选择在繁殖之后就放手了。",
    cfi: null,
    color: "#56aee2",
    style: "underline",
    note: "和《自私的基因》里那段对读。",
    createdAt: 1_700_000_300_000,
  },
  {
    id: "demo-a4",
    bookId: "demo-2",
    chapterIdx: 0,
    startChar: 60,
    endChar: 104,
    text: "医学擅长处理近因——哪一种细菌、哪一条通路；演化医学追问远因。",
    cfi: null,
    color: "#7cd92c",
    style: "highlight",
    note: null,
    createdAt: 1_700_000_400_000,
  },
  {
    id: "demo-a5",
    bookId: "demo-2",
    chapterIdx: 3,
    startChar: 0,
    endChar: 28,
    text: "理解这一点并不会立刻治好什么病，但它会改变提问的方式。",
    cfi: null,
    color: "#b08fe8",
    style: "squiggly",
    note: "提问方式决定找得到什么答案——这句可以拿去当书签。",
    createdAt: 1_700_000_500_000,
  },
];

/** One book's highlights, in reading order.
 *
 *  Handed out by reference, which is safe because nothing ever writes to an
 *  entry in place — every edit below replaces the element. */
export function demoAnnotationList(bookId: string): Annotation[] {
  return demoAnnotations.filter((entry) => entry.bookId === bookId);
}

/** Writes (or clears) a note on a sample highlight; `null` when it is gone. */
export function demoAnnotationNote(id: string, note: string | null): Annotation | null {
  const at = demoAnnotations.findIndex((entry) => entry.id === id);
  if (at < 0) return null;
  const updated = { ...demoAnnotations[at]!, note };
  demoAnnotations[at] = updated;
  return updated;
}

/** Drops a sample highlight. */
export function demoAnnotationDelete(id: string): void {
  const at = demoAnnotations.findIndex((entry) => entry.id === id);
  if (at >= 0) demoAnnotations.splice(at, 1);
}

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

/** `paragraphs`, repeated `times` over — the sample body of one chapter. */
const repeat = (times: number): string[] => Array.from({ length: times }, () => PARAGRAPHS).flat();

/**
 * The body of each chapter.
 *
 * The first three are ten times the shared pool, long enough to paginate into
 * several pages. The last is a single paragraph, deliberately: the whole-book
 * page indicator reads a book's length off the units it has measured, and a
 * shelf whose chapters are all one length makes every estimator look right —
 * including the one that extrapolated the book from whichever chapter happened
 * to be on screen, which reported 493 pages and then 2202 for the same EPUB.
 * One long chapter against one very short one is what tells those two apart,
 * and a very short chapter is where the real thing goes wrong too: the last
 * page of a chapter is never full.
 *
 * It keeps the paragraph `demo-a5` quotes, so the notes page still finds the
 * line it points at on a real page of the book.
 */
const CHAPTER_BODIES: string[][] = [repeat(10), repeat(10), repeat(10), [PARAGRAPHS[5]!]];

export const demoToc: ChapterMeta[] = CHAPTER_TITLES.map((title, idx) => ({
  idx,
  title,
  chars: (CHAPTER_BODIES[idx] ?? []).join("").length,
}));

export function demoChapter(idx: number): ChapterContent | null {
  const title = CHAPTER_TITLES[idx];
  const paragraphs = CHAPTER_BODIES[idx];
  if (title === undefined || paragraphs === undefined) return null;
  return { idx, title, paragraphs };
}
