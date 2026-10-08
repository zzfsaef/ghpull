// SPDX-License-Identifier: MIT
/**
 * 断点续传的状态文件与分片文件布局。
 *
 * 布局（相对目标文件）：
 *   <dest>                                最终产物
 *   <dest>.ghpull/state.json              分段表 + 元数据（原子写：.tmp → fsync → rename）
 *   <dest>.ghpull/seg-<start>.part        以分段**起始偏移**命名的分片文件
 *
 * 分片命名规则：`seg-<start>.part`，只用起始偏移，**不写 end**。start 在分段表里唯一
 * 且在分段的一生里不变；end 会变（「边下边切分」会把一个分段对半切开，左边那段的 end
 * 立刻变小）。若名字里带上 end，切分/重试之后同一段就会换一个新文件名：已经写下的
 * `done` 个字节还留在旧名字的文件里，新文件从偏移 `done` 开始追加，成品就会**缺掉开头
 * `done` 个字节**，而 `done` 已经记到段长、还会被判成「已完成」——真机压力用例实测到过
 * 产物比声明短 163840 字节。只按 start 命名则「同一段 = 同一个文件」，切分、重试、
 * 续传都不换身份，也让关流后的「磁盘上不能比分段长」对账始终盯着正确的文件。
 *
 * 与更早的版本命名兼容（早期就是 `seg-<start>.part`）。
 *
 * 状态文件的可信度：state.json 只当「线索」，不当事实。readState 只返回**形状与范围
 * 自洽**的状态（见 isSelfConsistentState），任何不自洽一律返回 null ⇒ 上层当作无断点、
 * 重新规划分段。真伪的最终裁判是磁盘：引擎会拿 part 文件的实际大小对齐每段的 done。
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** 状态文件格式版本；不兼容变更时递增，读到不认识的就当作无状态。 */
export const STATE_VERSION = 1;

/**
 * 分片目录。
 * @param {string} dest
 */
export function partsDirFor(dest) {
  return `${dest}.ghpull`;
}

/**
 * 状态文件路径。
 * @param {string} dest
 */
export function stateFileFor(dest) {
  return path.join(partsDirFor(dest), "state.json");
}

/**
 * 某个分段的文件路径。
 *
 * **名字只编码 start，绝不编码 end。** 分段的一生里 start 不变，end 会因为「边下边切分」
 * 而变小；如果名字带上 end，同一段被切分（或重试）之后就会换成一个新文件名，已经写下的
 * 那 `done` 个字节还留在旧名字的文件里 —— 新文件从偏移 `done` 开始追加，成品就会**缺掉
 * 开头 `done` 个字节**（真机压力用例实测：产物比声明短 163840 字节，且因为 done 记到了
 * 段长，它还会被判成「已完成」）。只按 start 命名就让「同一段 = 同一个文件」，切分、
 * 重试、续传都不换身份。start 在分段表里天然唯一（切分时左边保留 start、右边拿新 start）。
 *
 * 调用契约：同步返回路径，`end` 仍必填 —— 传不出合法区间时**直接抛错**，而不是静默生成
 * `seg-undefined.part` 这种所有分段都撞在一起的名字。
 *
 * @param {string} dest
 * @param {number} start 分段起始偏移（闭区间左端）
 * @param {number} end 分段结束偏移（闭区间右端，含）；只参与校验
 */
export function partFileFor(dest, start, end) {
  if (!isCount(start) || !isCount(end) || end < start) {
    throw new TypeError(
      `partFileFor：start/end 必须是非负安全整数且 end >= start（收到 start=${String(start)}、end=${String(end)}）；` +
        "分片名按 start 编码（seg-<start>.part），但仍要求传完整区间以免误用",
    );
  }
  return path.join(partsDirFor(dest), `seg-${start}.part`);
}

/**
 * 非负安全整数：排除负数、小数、NaN/Infinity、字符串数字（"80"）、null。
 * @param {unknown} value
 */
function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 状态自洽性校验。任一条不满足 ⇒ 整份状态不可信（返回 null，由上层重新规划）。
 *
 * 规则（全部为「形状与范围」级，不读盘）：
 *   - 顶层是对象（非数组/非 null）
 *   - version 与 STATE_VERSION 精确相等
 *   - size 是非负安全整数（缺 size、size 为负数/小数/字符串都算不自洽）
 *   - segments 是数组；size > 0 时至少有一段（空计划描述不了任何文件）
 *   - 每段是对象，start/end/done 都是非负安全整数（字符串 "80" 不接受）
 *   - end >= start（负长度不允许）
 *   - end < size（越界不允许）
 *   - done <= end - start + 1（done 不可能超过分段长度）
 *   - 分段两两不重叠：按 start 排序后前一段的 end 严格小于后一段的 start
 *   - 覆盖总长不超过 size（不重叠 + 每段 end < size 已蕴含，这里显式再核一次）
 *
 * @param {unknown} parsed
 */
function isSelfConsistentState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const state = /** @type {Record<string, unknown>} */ (parsed);
  if (state.version !== STATE_VERSION) return false;
  if (!isCount(state.size)) return false;
  const size = /** @type {number} */ (state.size);
  if (!Array.isArray(state.segments)) return false;
  if (state.segments.length === 0 && size > 0) return false;

  const ranges = [];
  for (const entry of state.segments) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const segment = /** @type {Record<string, unknown>} */ (entry);
    const { start, end, done } = segment;
    if (!isCount(start) || !isCount(end) || !isCount(done)) return false;
    if (end < start) return false;
    if (end >= size) return false;
    if (done > end - start + 1) return false;
    ranges.push(/** @type {[number, number]} */ ([start, end]));
  }

  ranges.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    if (index > 0 && ranges[index - 1][1] >= ranges[index][0]) return false; // 重叠
    covered += ranges[index][1] - ranges[index][0] + 1;
  }
  return covered <= size;
}

/**
 * 读状态。文件不存在、JSON 坏了、版本不认识、或**任何自洽性校验不过**，一律返回 null
 * （上层会当作没有断点，重新规划分段 —— 这是安全方向）。
 *
 * @param {string} dest
 * @returns {Promise<null | {version: number, url: string, size: number, etag?: string, lastModified?: string, sha256?: string, segments: {start: number, end: number, done: number}[]}>}
 */
export async function readState(dest) {
  try {
    const text = await readFile(stateFileFor(dest), "utf8");
    const parsed = JSON.parse(text);
    if (!isSelfConsistentState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 原子写入状态：同目录 .tmp → fsync → rename。
 *
 * 顺序是有意的：先把内容写进 .tmp 并 `sync()` 落盘，再 rename 覆盖 state.json。
 * 这样「state 比 .part 新」不可能由掉电/硬杀造成 —— 否则下次会信任 done 跳过根本没
 * 落盘的那段数据，成品静默损坏。rename 之前任何一步失败都只留下 .tmp，旧 state.json
 * 原封不动（**不要**为了「干净」去删旧文件，旧状态仍可用才是安全方向）。
 *
 * `version` 在展开之后写死为 STATE_VERSION：调用方传 version 也覆盖不了常量，
 * 避免写出一个下次被 readState 直接丢弃的状态文件。
 *
 * @param {string} dest
 * @param {object} state
 */
export async function writeState(dest, state) {
  const dir = partsDirFor(dest);
  await mkdir(dir, { recursive: true });
  const target = stateFileFor(dest);
  const tmp = `${target}.tmp`;
  const payload = `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`;

  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

/**
 * 删除整个分片目录（完成、或被放弃时）。
 * @param {string} dest
 */
export async function clearParts(dest) {
  await rm(partsDirFor(dest), { recursive: true, force: true });
}

/**
 * 确保分片目录存在。
 * @param {string} dest
 */
export async function ensurePartsDir(dest) {
  await mkdir(partsDirFor(dest), { recursive: true });
}
