// SPDX-License-Identifier: MIT
/**
 * 命令行参数：`node:util.parseArgs` + 自己的一层校验。
 *
 * 为什么自己写校验：parseArgs 的 `type` 只有 `boolean` / `string`，数值范围、
 * 尺寸单位、互斥关系都得自己来；boolean 选项没给 default 时结果里干脆没有这个键
 * （不是 `false`），所以最后统一归一化。
 */

import { parseArgs } from "node:util";

import { UsageError } from "./errors.mjs";
import { TRANSPORTS } from "./transport.mjs";

const SIZE_UNITS = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * 解析尺寸：`1048576`、`512K`、`8M`、`1GiB`、`20MiB/s`（尾部 `/s` 会被忽略）。
 * @param {string} text
 * @param {string} label 出错时用于提示的选项名
 * @returns {number} 字节数
 */
export function parseSize(text, label) {
  const raw = String(text).trim().replace(/\/s$/i, "");
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(raw);
  if (!match) throw new UsageError(`${label} 取值无法解析为尺寸：${text}`);
  const value = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const factor = SIZE_UNITS[unit];
  if (factor === undefined) throw new UsageError(`${label} 的单位无法识别：${text}（可用 K/KiB/M/MiB/G/GiB）`);
  const bytes = Math.round(value * factor);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new UsageError(`${label} 必须是正数：${text}`);
  return bytes;
}

/**
 * 解析非负整数。
 * @param {string} text
 * @param {string} label
 * @param {{min?: number, max?: number}} [bounds]
 */
export function parseCount(text, label, bounds = {}) {
  const raw = String(text).trim();
  if (!/^\d+$/.test(raw)) throw new UsageError(`${label} 必须是非负整数：${text}`);
  const value = Number(raw);
  const min = bounds.min ?? 0;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) throw new UsageError(`${label} 必须介于 ${min} 与 ${max} 之间，收到的是 ${value}`);
  return value;
}

/** 帮助文本。 */
export const HELP = `ghpull — 多源分段下载器（零依赖，Node >= 18）

用法：
  ghpull <url> [选项]

示例：
  ghpull https://example.com/big.iso
  ghpull https://github.com/user/repo/releases/download/v1/app.zip -o app.zip --sha256 <64位十六进制>
  ghpull https://example.com/big.iso --conns 8 --max-conns 16 --timeout 30
  ghpull https://example.com/big.iso --mirror "https://my-mirror.example/{url}" --mirror-mode manual

输出与断点：
  -o, --out <文件>        输出路径（默认取 Content-Disposition / URL 末段）
      --force             删除已存在的目标与断点，从头下载
      --continue          目标已存在时继续或校验，而不是拒绝
      --no-resume         丢弃已有断点，重新开始（不删除目标文件）
      --keep-parts        成功后保留 .ghpull 分片目录

并发与超时：
      --conns <n>         初始并发连接数（默认 8）
      --max-conns <n>     自适应并发上限（默认 16）
      --min-split <尺寸>  最小分段长度（默认 8MiB，可取 4M / 8MiB）
      --timeout <秒>      单次请求超时（默认 30）
      --stall-sec <秒>    超过这么久没有任何新字节就判定停滞并换源（默认 12）
      --lowest-speed <速率>  启动期后低于此速率即判为过慢（默认 1KiB/s）
      --retries <n>       每个分段最大重试次数（默认 5）

来源：
      --mirror <模板>     追加镜像模板，必须含 {url}，可重复
      --mirror-mode <模式>  off（默认）/ manual / auto
                          off 只用原始 URL；manual 只用 --mirror 给的；
                          auto 额外启用内置的第三方镜像清单
                          （内置清单是第三方公共服务，默认不启用，可用性与合法性自行判断）
      --transport <模式>   auto（默认）/ node / curl
                          auto 先用内置 HTTP 客户端，遇到证书错误再降级到 curl
      --curl-path <路径>   指定 curl 可执行文件
      --config <文件>      JSON 配置文件，命令行显式给出的选项优先
                          可用的键：conns, maxConns, minSplit, mirrorMode,
                          mirrors, transport, curlPath, timeoutSec, stallSec,
                          lowestSpeed, retries, progress

校验与输出：
      --sha256 <哈希>      期望的 SHA-256（可带 sha256: 前缀）
      --progress <模式>    auto（默认）/ plain / none / json
      --json               以 JSON 输出结果摘要（等价于 --progress none 加摘要）
  -v, --verbose           打印诊断信息
  -h, --help              显示本帮助
  -V, --version           显示版本

退出码：
  0 成功   1 失败   2 用法错误   3 目标已存在   4 校验失败   5 目标不支持   6 所有来源不可用
  130 被 SIGINT/SIGTERM 中断（断点保留在 <输出>.ghpull/，直接重跑即可续传）

说明：
  - 默认不启用任何第三方代理或镜像；要提速需自己用 --mirror 提供可用来源。
  - 中断或崩溃后重跑同一条命令会自动续传；--no-resume 丢弃断点，--force 连同目标文件一起删。
`;

/** parseArgs 的选项表。 */
const OPTION_TABLE = {
  out: { type: "string", short: "o" },
  force: { type: "boolean" },
  continue: { type: "boolean" },
  "no-resume": { type: "boolean" },
  "keep-parts": { type: "boolean" },
  conns: { type: "string" },
  "max-conns": { type: "string" },
  "min-split": { type: "string" },
  timeout: { type: "string" },
  "stall-sec": { type: "string" },
  "lowest-speed": { type: "string" },
  retries: { type: "string" },
  mirror: { type: "string", multiple: true },
  "mirror-mode": { type: "string" },
  transport: { type: "string" },
  "curl-path": { type: "string" },
  config: { type: "string" },
  sha256: { type: "string" },
  progress: { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

/**
 * @typedef {object} CliOptions
 * @property {string} url
 * @property {string|null} out
 * @property {boolean} force
 * @property {boolean} continueDownload
 * @property {boolean} resume
 * @property {boolean} keepParts
 * @property {number} conns
 * @property {number} maxConns
 * @property {number} minSplit
 * @property {number} timeoutSec
 * @property {number} stallSec
 * @property {number} lowestSpeed
 * @property {number} retries
 * @property {string[]} mirrors
 * @property {"off"|"manual"|"auto"} mirrorMode
 * @property {string} transport
 * @property {string|undefined} curlPath
 * @property {string|undefined} config
 * @property {string|undefined} sha256
 * @property {"auto"|"plain"|"none"|"json"} progress
 * @property {boolean} json
 * @property {boolean} verbose
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * 解析 argv。
 * @param {string[]} argv 不含 node 与脚本路径
 * @param {Record<string, any>} [base] 配置文件提供的默认值（命令行显式给出的一律优先）
 * @returns {CliOptions}
 */
export function parseCliArgs(argv, base) {
  const cfg = base ?? {};
  /** @type {{values: Record<string, any>, positionals: string[]}} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTION_TABLE, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(/** @type {Error} */ (error).message);
  }
  const values = parsed.values ?? {};
  const positionals = parsed.positionals ?? [];

  if (values.help === true) return withDefaults({ help: true, version: false });
  if (values.version === true) return withDefaults({ help: false, version: true });

  const url = positionals[0];
  if (!url) throw new UsageError("缺少要下载的 URL。用 `ghpull --help` 查看用法。");
  if (positionals.length > 1) {
    throw new UsageError(`只接受一个 URL，多出来的是：${positionals.slice(1).join(" ")}`);
  }

  const conns = values.conns === undefined
    ? cfgCount(cfg.conns, 8, "--conns(config)", { min: 1, max: 64 })
    : parseCount(values.conns, "--conns", { min: 1, max: 64 });
  const maxConns = values["max-conns"] === undefined
    ? cfgCount(cfg.maxConns, 16, "--max-conns(config)", { min: 1, max: 128 })
    : parseCount(values["max-conns"], "--max-conns", { min: 1, max: 128 });
  if (maxConns < conns) {
    throw new UsageError(`--max-conns（${maxConns}）不能小于 --conns（${conns}）`);
  }

  const minSplit = values["min-split"] === undefined
    ? cfgSize(cfg.minSplit, 8 * 1024 * 1024, "--min-split(config)")
    : parseSize(values["min-split"], "--min-split");
  if (minSplit < 64 * 1024) throw new UsageError(`--min-split 至少 64KiB，收到的是 ${values["min-split"] ?? minSplit}`);

  const mirrorMode = values["mirror-mode"] ?? cfg.mirrorMode ?? "off";
  if (!["off", "manual", "auto"].includes(mirrorMode)) {
    throw new UsageError(`--mirror-mode 只能是 off / manual / auto，收到的是 ${mirrorMode}`);
  }
  const mirrors = [
    ...(Array.isArray(cfg.mirrors) ? cfg.mirrors : []),
    ...(Array.isArray(values.mirror) ? values.mirror : []),
  ];
  if (mirrorMode === "manual" && mirrors.length === 0) {
    throw new UsageError("--mirror-mode manual 需要至少一个 --mirror 模板");
  }

  const transport = values.transport ?? cfg.transport ?? "auto";
  if (!TRANSPORTS.includes(transport)) {
    throw new UsageError(`--transport 只能是 ${TRANSPORTS.join(" / ")}，收到的是 ${transport}`);
  }

  const progress = values.json === true ? "json" : values.progress ?? cfg.progress ?? "auto";
  if (!["auto", "plain", "none", "json"].includes(progress)) {
    throw new UsageError(`--progress 只能是 auto / plain / none / json，收到的是 ${progress}`);
  }
  if (values.force === true && values.continue === true) {
    throw new UsageError("--force 与 --continue 互斥：一个要重下，一个要在已有文件上继续");
  }

  return withDefaults({
    url,
    out: values.out ?? null,
    force: values.force === true,
    continueDownload: values.continue === true,
    resume: values["no-resume"] !== true,
    keepParts: values["keep-parts"] === true,
    conns,
    maxConns,
    minSplit,
    timeoutSec: values.timeout === undefined
      ? cfgCount(cfg.timeoutSec, 30, "--timeout(config)", { min: 1, max: 3600 })
      : parseCount(values.timeout, "--timeout", { min: 1, max: 3600 }),
    stallSec: values["stall-sec"] === undefined
      ? cfgCount(cfg.stallSec, 12, "--stall-sec(config)", { min: 3, max: 3600 })
      : parseCount(values["stall-sec"], "--stall-sec", { min: 3, max: 3600 }),
    lowestSpeed: values["lowest-speed"] === undefined
      ? cfgSize(cfg.lowestSpeed, 1024, "--lowest-speed(config)")
      : parseSize(values["lowest-speed"], "--lowest-speed"),
    retries: values.retries === undefined
      ? cfgCount(cfg.retries, 5, "--retries(config)", { min: 0, max: 50 })
      : parseCount(values.retries, "--retries", { min: 0, max: 50 }),
    mirrors,
    mirrorMode,
    transport,
    curlPath: values["curl-path"] ?? cfg.curlPath,
    config: values.config,
    sha256: values.sha256,
    progress,
    json: values.json === true,
    verbose: values.verbose === true,
  });
}

/**
 * 补齐所有键，避免调用方到处判 undefined。
 * @param {Partial<CliOptions> & {url?: string}} partial
 * @returns {CliOptions}
 */
export function withDefaults(partial) {
  return /** @type {CliOptions} */ ({
    url: "",
    out: null,
    force: false,
    continueDownload: false,
    resume: true,
    keepParts: false,
    conns: 8,
    maxConns: 16,
    minSplit: 8 * 1024 * 1024,
    timeoutSec: 30,
    stallSec: 12,
    lowestSpeed: 1024,
    retries: 5,
    mirrors: [],
    mirrorMode: "off",
    transport: "auto",
    curlPath: undefined,
    config: undefined,
    sha256: undefined,
    progress: "auto",
    json: false,
    verbose: false,
    help: false,
    version: false,
    ...partial,
  });
}

/**
 * 读取 JSON 配置文件（可选）。文件里的值只作为**默认值**，命令行给了就覆盖命令行。
 * @param {string} file
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readConfigFile(file) {
  const { readFile } = await import("node:fs/promises");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`读不到配置文件：${file}（${/** @type {Error} */ (error).message}）`);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是对象");
    }
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch (error) {
    throw new UsageError(`配置文件不是合法 JSON：${file}（${/** @type {Error} */ (error).message}）`);
  }
}

/**
 * 配置文件里的计数值：数字直接校验，字符串走与命令行同一套解析。
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 * @param {{min?: number, max?: number}} bounds
 */
function cfgCount(value, fallback, label, bounds) {
  if (value === undefined || value === null) return fallback;
  return parseCount(String(value), label, bounds);
}

/**
 * 配置文件里的尺寸值（支持 8MiB / "8M" 这类写法）。
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 */
function cfgSize(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  return parseSize(String(value), label);
}
