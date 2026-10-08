// SPDX-License-Identifier: MIT
/**
 * 校验：长度与 SHA-256。
 *
 * 只有「期望值」和「实际值」都拿到时才下结论；缺少期望值绝不假装校验通过。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * 解析 `--sha256` 的取值：接受 `sha256:<hex>`、`<hex>`，大小写不敏感。
 * @param {string} text
 * @returns {string} 小写十六进制
 * @throws {Error} 格式不合法时抛出
 */
export function parseExpectedHash(text) {
  const raw = String(text).trim();
  const withoutPrefix = raw.replace(/^sha256:/i, "").trim();
  if (!/^[0-9a-f]{64}$/i.test(withoutPrefix)) {
    throw new Error(`SHA-256 取值必须是 64 位十六进制（可带 sha256: 前缀），收到的是：${text}`);
  }
  return withoutPrefix.toLowerCase();
}

/**
 * 流式计算文件的 SHA-256，可按块回调进度。
 * @param {string} file
 * @param {{onProgress?: (readBytes: number) => void, highWaterMark?: number}} [options]
 * @returns {Promise<string>} 小写十六进制
 */
export async function sha256File(file, options = {}) {
  const hash = createHash("sha256");
  let readBytes = 0;
  const stream = createReadStream(file, { highWaterMark: options.highWaterMark ?? 1 << 20 });
  for await (const chunk of stream) {
    hash.update(/** @type {Buffer} */ (chunk));
    readBytes += /** @type {Buffer} */ (chunk).length;
    options.onProgress?.(readBytes);
  }
  return hash.digest("hex");
}

/**
 * 读取文件大小；文件不存在时返回 null（而不是抛错，调用方常需要「不存在」这个答案）。
 * @param {string} file
 * @returns {Promise<number|null>}
 */
export async function sizeOf(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * 比较哈希，不相等时给出可读差异（前 12 位足够定位，避免刷屏）。
 * @param {string} expected 小写十六进制
 * @param {string} actual 小写十六进制
 * @returns {{ok: boolean, message: string}}
 */
export function compareHash(expected, actual) {
  if (expected === actual) return { ok: true, message: "SHA-256 一致" };
  return {
    ok: false,
    message: `SHA-256 不一致：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
  };
}
