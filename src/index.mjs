// SPDX-License-Identifier: MIT
/**
 * 对外 API。CLI 只是这一层的一个调用方。
 *
 * @example
 * import { download } from "ghpull";
 * const result = await download("https://example.com/big.bin", { conns: 8, out: "big.bin" });
 * console.log(result.sha256);
 */

import { withDefaults } from "./args.mjs";
import { Engine } from "./engine.mjs";

export { Engine, Segment } from "./engine.mjs";
export { probe, openRange, detectCurl, closeAgents } from "./transport.mjs";
export {
  EXIT,
  EXIT_TEXT,
  GhpullError,
  UsageError,
  DestinationExistsError,
  ChecksumError,
  SourceError,
  UnsupportedError,
  NoSourceError,
  toGhpullError,
} from "./errors.mjs";
export { parseExpectedHash, sha256File, compareHash } from "./verify.mjs";
export { parseCliArgs, HELP } from "./args.mjs";
export { VERSION } from "./version.mjs";

/**
 * 下载一个 URL。
 * @param {string} url
 * @param {Partial<import("./args.mjs").CliOptions> & {signal?: AbortSignal}} [options]
 * @param {{onEvent?: (event: any) => void, log?: (message: string) => void}} [hooks]
 * @returns {Promise<object>} 结果摘要
 */
export async function download(url, options = {}, hooks = {}) {
  const normalized = withDefaults({ ...options, url });
  const engine = new Engine({ ...normalized, signal: options.signal }, hooks);
  return engine.run();
}
