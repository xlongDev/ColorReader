/**
 * MDict (`.mdx`), read-only — the browser's copy of `src-tauri/src/library/mdict.rs`.
 *
 * The two are meant to be read side by side: same field order, same three
 * checksums, same refusals by name. The differences are all consequences of
 * where the bytes live. The Rust reader holds a `File` and reads two blocks per
 * lookup; here the whole `.mdx` is already in memory (IndexedDB hands it over
 * as one `ArrayBuffer`), so a lookup slices `Uint8Array`s instead of seeking,
 * and `openIndex` is `async` because inflating is.
 *
 * **The scope is narrowed on purpose** and each narrowing is refused by name
 * when the header announces it, rather than half-parsing: version **2.0**,
 * encoding **UTF-8**, **nothing encrypted**. Version 1.2 makes every size field
 * 4 bytes instead of 8, the other encodings need GBK / Big5 decoders, and
 * encryption has two paths keyed off the reader's mail or device id. Guessing
 * at any of them yields plausible mojibake, which is worse than a refusal.
 * `.mdd` resource bundles are out of scope too — the popup shows text.
 *
 * Three checksums appear in the file in three different byte orders: the
 * header's is little-endian, the key section's preamble's is big-endian, and a
 * block's is big-endian over the *decompressed* data. All three are verified.
 */

/// The only engine version parsed; 1.2 uses 4-byte size fields throughout.
const ENGINE_VERSION = "2.0";
/// The only encoding parsed; the others need GBK / Big5 decoders.
const ENCODING = "UTF-8";
const COMPRESSION_NONE = 0;
const COMPRESSION_ZLIB = 2;
/** A header or block larger than this is a corrupt field claiming a huge size,
 *  and trusting it would take the process down. */
const MAX_HEADER_BYTES = 4 << 20;
const MAX_BLOCK_BYTES = 32 << 20;

function corrupt(message: string): never {
  throw new Error(`词典文件已损坏：${message}`);
}

/** What the header says about a dictionary. */
export interface MdictMetadata {
  title: string;
  description: string;
}

/** One key block's entry in the key section's index. */
interface KeyBlock {
  /** Offset of the block's compressed data. */
  offset: number;
  /** Compressed size, the 8-byte block header included. */
  compressed: number;
  /** The block's first and last keys, which say whether the term lives here. */
  first: Uint8Array;
  last: Uint8Array;
}

/** One record block's entry in the record section's index. */
interface RecordBlock {
  offset: number;
  compressed: number;
  /** Running total of the decompressed sizes of the blocks before this one. A
   *  key stores an offset into the plainly concatenated records, so this is what
   *  turns it back into a block plus an offset inside it. */
  startsAt: number;
  decompressed: number;
}

/** Everything read once per dictionary: the header and both block indexes. */
export interface MdictIndex {
  metadata: MdictMetadata;
  /** Entry count from the key section; the header does not carry it. */
  wordcount: number;
  keyBlocks: KeyBlock[];
  records: RecordBlock[];
}

/**
 * Parses the header, refusing the shapes this reader cannot parse.
 *
 * One flat `<Dictionary .../>` tag, always — so this reads it with a regex
 * rather than standing an XML parser up, and a missing attribute answers as the
 * empty string, which is what the three refusals key off.
 */
export function parseHeader(text: string): MdictMetadata {
  if (!/<Dictionary[\s>]/i.test(text)) {
    throw new Error("这不是 MDict 词典：头部没有 XML 标签");
  }
  const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(text)?.[1] ?? "";

  const version = attribute("GeneratedByEngineVersion");
  if (version !== ENGINE_VERSION) {
    throw new Error(`这本词典是 MDict ${version} 格式，本版本只支持 ${ENGINE_VERSION}`);
  }
  const encoding = attribute("Encoding").toUpperCase();
  if (encoding !== ENCODING) {
    throw new Error(`这本词典是 ${encoding} 编码，本版本只支持 ${ENCODING}`);
  }
  const encrypted = attribute("Encrypted");
  if (encrypted !== "0" && encrypted !== "") {
    throw new Error("这本词典的内容是加密的，本版本不支持");
  }
  return { title: attribute("Title"), description: attribute("Description") };
}

/** Adler-32: the checksum the format uses for the header, the key section's
 *  preamble and every block. */
export function adler32(bytes: Uint8Array): number {
  const MODULUS = 65521;
  let low = 1;
  let high = 0;
  for (const byte of bytes) {
    low = (low + byte) % MODULUS;
    high = (high + low) % MODULUS;
  }
  return ((high << 16) | low) >>> 0;
}

/** Reads the header and walks both block indexes. */
export async function openIndex(bytes: ArrayBuffer): Promise<MdictIndex> {
  const view = new DataView(bytes);
  const metadata = readHeader(bytes, view);

  // Key section: a 40-byte preamble, its 4-byte checksum, the compressed block
  // index, then the blocks.
  const at = 4 + headerLength(view) + 4;
  const preamble = new Uint8Array(bytes, at, 40);
  if (view.getUint32(at + 40) !== adler32(preamble)) corrupt("键区前言校验不对");
  const expectedKeyBlocks = u64(preamble, 0);
  const wordcount = u64(preamble, 8);
  const indexDecompressed = u64(preamble, 16);
  const indexCompressed = u64(preamble, 24);
  const blocksTotal = u64(preamble, 32);

  const indexStart = at + 44;
  const keyBlocksStart = indexStart + indexCompressed;
  const plainIndex = await decompress(span(bytes, indexStart, indexCompressed));
  if (plainIndex.length !== indexDecompressed) corrupt("键块索引解压后的大小不对");
  const keyBlocks = parseKeyIndex(plainIndex, keyBlocksStart);
  if (keyBlocks.length !== expectedKeyBlocks) corrupt("键块数量与前言的声明不符");
  if (total(keyBlocks.map((block) => block.compressed)) !== blocksTotal) {
    corrupt("键块总大小与前言的声明不符");
  }

  // Record section: a 32-byte preamble, then an *uncompressed* block index.
  const records = readRecordIndex(bytes, keyBlocksStart + blocksTotal);
  return { metadata, wordcount, keyBlocks, records };
}

/** The entry for `term`, or `null` when the dictionary does not carry it. */
export async function lookup(
  bytes: ArrayBuffer,
  index: MdictIndex,
  term: string,
): Promise<string | null> {
  const needle = new TextEncoder().encode(term);
  // Blocks are sorted and do not overlap, so the one whose interval holds the
  // term is the only one that can. A scan is plenty: even a huge dictionary has
  // thousands of blocks, not millions.
  const block = index.keyBlocks.find(
    (candidate) => compare(candidate.first, needle) <= 0 && compare(needle, candidate.last) <= 0,
  );
  if (!block) return null;

  const plain = await decompress(span(bytes, block.offset, block.compressed));
  const cursor = new Cursor(plain);
  let found: number | null = null;
  while (!cursor.done) {
    const offset = cursor.number();
    const key = cursor.cstring();
    if (compare(key, needle) === 0) {
      found = offset;
      break;
    }
  }
  return found === null ? null : readRecord(bytes, index, found);
}

/** Reads the record at a logical offset into the concatenated records. */
async function readRecord(
  bytes: ArrayBuffer,
  index: MdictIndex,
  offset: number,
): Promise<string | null> {
  const block = index.records.find(
    (candidate) =>
      offset >= candidate.startsAt && offset < candidate.startsAt + candidate.decompressed,
  );
  if (!block) return null;

  const plain = await decompress(span(bytes, block.offset, block.compressed));
  const rest = plain.subarray(offset - block.startsAt);
  // A record runs to its NUL, which the writer guarantees.
  const end = rest.indexOf(0);
  const raw = new TextDecoder().decode(end === -1 ? rest : rest.subarray(0, end));
  // MDX records are HTML when the header says `Format="Html"`; the popup shows
  // text, so the tags come off (which also trims).
  const text = textFromMarkup(raw);
  return text === "" ? null : text;
}

/** A block's bytes, refusing a size only a corrupt field would claim. */
function span(bytes: ArrayBuffer, offset: number, size: number): Uint8Array {
  if (size > MAX_BLOCK_BYTES) corrupt("块长度不合理");
  if (offset + size > bytes.byteLength) corrupt("块超出文件末尾");
  return new Uint8Array(bytes, offset, size);
}

/** Strips a block's 8-byte preamble and inflates its payload.
 *
 *  The preamble is a *little-endian* compression type followed by the
 *  *big-endian* Adler-32 of the decompressed data — the two ends differ, and
 *  getting either wrong reads plausible garbage. */
async function decompress(block: Uint8Array): Promise<Uint8Array> {
  if (block.length < 8) corrupt("块太短，缺少 8 字节头部");
  const kind = u32(block, 0, true);
  const expected = u32(block, 4, false);
  const payload = block.subarray(8);
  // Type 1 is LZO, which needs a decoder neither build carries. Refusing a
  // compression we cannot read is a scope answer, not damage.
  if (kind !== COMPRESSION_NONE && kind !== COMPRESSION_ZLIB) {
    throw new Error(`词典使用了不支持的压缩方式（${kind}），本版本只支持 zlib`);
  }
  const data = kind === COMPRESSION_ZLIB ? await inflate(payload) : new Uint8Array(payload);
  if (adler32(data) !== expected) corrupt("块校验不对");
  return data;
}

/** zlib, through the platform's own decoder — no dependency for it.
 *
 *  Fed in as a `Response` body rather than a `Blob` stream: `Blob.stream()` is
 *  the one piece of this pipeline jsdom does not implement, and the test suite
 *  runs in it. */
async function inflate(payload: Uint8Array): Promise<Uint8Array> {
  // `Response` is typed from `@types/node` in this project, which asks for a
  // view over a plain `ArrayBuffer`; the browser's own `Response` — what runs
  // here — takes any view. A cast, not a copy: these blocks are megabytes.
  const plain = new Response(payload as Uint8Array<ArrayBuffer>).body?.pipeThrough(
    new DecompressionStream("deflate"),
  );
  if (!plain) throw new Error("词典解压失败：读不出压缩块");
  return new Uint8Array(await new Response(plain).arrayBuffer());
}

/** Walks the decompressed key block index.
 *
 *  Each entry is `u64 entries | u16 first key length | first key | NUL | u16
 *  last key length | last key | NUL | u64 compressed | u64 decompressed`. The
 *  lengths do **not** count the NUL that follows each key, so the cursor skips
 *  one byte after them. */
function parseKeyIndex(plain: Uint8Array, blocksStart: number): KeyBlock[] {
  const cursor = new Cursor(plain);
  const blocks: KeyBlock[] = [];
  let offset = blocksStart;
  while (!cursor.done) {
    cursor.number(); // entries in this block, only used by writers
    const first = cursor.key();
    const last = cursor.key();
    const compressed = cursor.number();
    cursor.number(); // decompressed size: the block header carries it too
    blocks.push({ offset, compressed, first, last });
    offset += compressed;
  }
  return blocks;
}

/** Walks the record block index, which is plain `(compressed, decompressed)`
 *  pairs and is not itself compressed. */
function readRecordIndex(bytes: ArrayBuffer, recordsStart: number): RecordBlock[] {
  const view = new DataView(bytes);
  const expected = u64At(view, recordsStart);
  const indexSize = u64At(view, recordsStart + 16);
  const blocksTotal = u64At(view, recordsStart + 24);
  if (indexSize % 16 !== 0) corrupt("记录块索引的长度不是 16 的整数倍");

  const cursor = new Cursor(span(bytes, recordsStart + 32, indexSize));
  const blocks: RecordBlock[] = [];
  let offset = recordsStart + 32 + indexSize;
  let startsAt = 0;
  while (!cursor.done) {
    const compressed = cursor.number();
    const decompressed = cursor.number();
    blocks.push({ offset, compressed, startsAt, decompressed });
    offset += compressed;
    startsAt += decompressed;
  }
  if (blocks.length !== expected) corrupt("记录块数量与前言的声明不符");
  if (total(blocks.map((block) => block.compressed)) !== blocksTotal) {
    corrupt("记录块总大小与前言的声明不符");
  }
  return blocks;
}

/** Reads the header at the start of the file: a 4-byte big-endian length, the
 *  XML in UTF-16LE, then its little-endian Adler-32. */
function readHeader(bytes: ArrayBuffer, view: DataView): MdictMetadata {
  const length = headerLength(view);
  const raw = span(bytes, 4, length);
  if (view.getUint32(4 + length, true) !== adler32(raw)) corrupt("头部校验不对");
  // The writer terminates the tag with `\r\n\0`, which the parser ignores.
  return parseHeader(new TextDecoder("utf-16le").decode(raw));
}

function headerLength(view: DataView): number {
  const length = view.getUint32(0);
  if (length === 0 || length > MAX_HEADER_BYTES) corrupt("头部长度不合理");
  if (4 + length + 4 > view.byteLength) corrupt("头部超出文件末尾");
  return length;
}

/** One big-endian `u64`, the width every size field uses at version 2.0.
 *
 *  Read as two halves rather than a `BigInt`: a real offset is far below 2^53,
 *  and the halves keep the arithmetic in plain numbers. */
function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at, false) * 2 ** 32 + u32(bytes, at + 4, false);
}

function u64At(view: DataView, at: number): number {
  return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
}

function u32(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  if (at + 4 > bytes.length) corrupt("字段被截断");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(at, littleEndian);
}

const total = (sizes: number[]): number => sizes.reduce((sum, size) => sum + size, 0);

/** Byte-wise order, the order the format sorts and searches its keys in. */
function compare(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** A bounds-checked cursor over a block's decompressed bytes.
 *
 *  Written out rather than indexed directly because every field in this format
 *  is a length-prefixed slice, and an off-by-one there reads a neighbouring
 *  entry instead of failing. */
class Cursor {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  private take(count: number): Uint8Array {
    if (this.at + count > this.bytes.length) corrupt("字段被截断");
    const slice = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return slice;
  }

  /** A big-endian `u64`. */
  number(): number {
    const value = u64(this.bytes, this.at);
    this.at += 8;
    return value;
  }

  /** A `u16` length followed by that many bytes and a NUL the length excludes. */
  key(): Uint8Array {
    if (this.at + 2 > this.bytes.length) corrupt("字段被截断");
    const length = (this.bytes[this.at]! << 8) | this.bytes[this.at + 1]!;
    this.at += 2;
    const key = new Uint8Array(this.take(length));
    this.take(1); // the NUL
    return key;
  }

  /** Bytes up to the next NUL, which is consumed. */
  cstring(): Uint8Array {
    const rest = this.bytes.subarray(this.at);
    const end = rest.indexOf(0);
    if (end === -1) corrupt("字符串没有结束符");
    this.at += end + 1;
    return rest.subarray(0, end);
  }
}

/** An MDX record as plain text: tags off, breaks kept as newlines, entities
 *  decoded. The popup shows text, not markup. */
function textFromMarkup(html: string): string {
  const breaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n");
  const parsed = new DOMParser().parseFromString(breaks, "text/html");
  return (parsed.body.textContent ?? "").trim();
}
