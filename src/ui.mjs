// SPDX-License-Identifier: MIT
/**
 * 进度与摘要输出。
 *
 * 四种模式：`auto`（TTY 走单行刷新，非 TTY 退化成逐行）、`plain`（逐行，CI 友好）、
 * `none`（静默）、`json`（NDJSON，机器可读）。所有人类可读信息写 stderr，
 * 只有 `--json` 的结果摘要写 stdout——这样管道里 `ghpull ... | jq` 不会被进度污染。
 */

import process from "node:process";

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/**
 * @param {number} bps
 */
export function formatBps(bps) {
  return `${formatBytes(bps)}/s`;
}

/**
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 进度条：20 格。 */
function bar(downloaded, total) {
  if (!total || total <= 0) return "";
  const ratio = Math.min(1, downloaded / total);
  const filled = Math.round(ratio * 20);
  return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${(ratio * 100).toFixed(1)}%`;
}

/**
 * 建一个事件消费者。
 * @param {{mode: "auto"|"plain"|"none"|"json", stderr?: NodeJS.WriteStream, stdout?: NodeJS.WriteStream, verbose?: boolean}} options
 */
export function createReporter(options) {
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const mode = options.mode === "auto" ? (stderr.isTTY ? "auto" : "plain") : options.mode;
  const interactive = mode === "auto" && Boolean(stderr.isTTY);
  let lastLineAt = 0;
  let lastLineLength = 0;

  /** @param {string} line */
  const writeLine = (line) => {
    if (mode === "none" || mode === "json") return;
    if (interactive) {
      const padded = line.length >= lastLineLength ? line : line + " ".repeat(lastLineLength - line.length);
      stderr.write(`\r${padded}`);
      lastLineLength = line.length;
    } else {
      stderr.write(`${line}\n`);
    }
  };

  /** 交互模式下换行，避免与后续输出粘在一起。 */
  const newline = () => {
    if (interactive && lastLineLength > 0) {
      stderr.write("\n");
      lastLineLength = 0;
    }
  };

  const describeProgress = (event) => {
    const parts = [];
    if (event.total) parts.push(bar(event.downloaded, event.total));
    parts.push(`${formatBytes(event.downloaded)}${event.total ? `/${formatBytes(event.total)}` : ""}`);
    parts.push(formatBps(event.bps));
    if (event.total) {
      const remain = Math.max(0, event.total - event.downloaded);
      const eta = event.bps > 0 ? remain / event.bps : Number.POSITIVE_INFINITY;
      if (Number.isFinite(eta)) parts.push(`ETA ${formatDuration(eta)}`);
    }
    parts.push(`连接 ${event.conns}/${event.targetConns}`);
    if (event.sources > 1) parts.push(`来源 ${event.sources}`);
    return parts.join("  ");
  };

  return {
    /** @param {any} event */
    handle(event) {
      if (mode === "json") {
        if (event.type === "progress") {
          stdout.write(`${JSON.stringify({ type: "progress", ...event })}\n`);
        }
        return;
      }
      switch (event.type) {
        case "probe":
          newline();
          if (options.verbose) {
            stderr.write(
              `目标：${formatBytes(event.size)}，传输层 ${event.transport}，分段支持 ${event.acceptRanges ? "是" : "否"}\n`,
            );
          }
          break;
        case "race":
          newline();
          if (options.verbose) stderr.write(`正在为 ${event.candidates} 个来源做竞速探测…\n`);
          break;
        case "race-done":
          newline();
          if (options.verbose) {
            for (const result of event.results) {
              stderr.write(`  ${result.name}：${result.ok ? formatBps(result.bps) : "不可用"}\n`);
            }
          }
          break;
        case "resume":
          newline();
          stderr.write(`发现断点：复用 ${formatBytes(event.reused)}（${event.segments} 个分段）\n`);
          break;
        case "plan":
          newline();
          if (options.verbose) {
            const how = event.minSplitAuto ? "，按文件大小自适应" : "";
            stderr.write(`分段计划：${event.segments} 段，最小分段 ${formatBytes(event.minSplit)}${how}\n`);
          }
          break;
        case "ramp":
          newline();
          if (options.verbose) {
            stderr.write(`并发升到 ${event.target} 条（${formatBps(event.bps)}，${event.reason}）\n`);
          }
          break;
        case "ramp-done":
          newline();
          if (options.verbose) {
            stderr.write(`并发定在 ${event.conns} 条（${formatBps(event.bps)}，${event.reason}）\n`);
          }
          break;
        case "ramp-reset":
          newline();
          if (options.verbose) {
            stderr.write(`并发闸门重开（${formatBps(event.bps)}，${event.reason}）\n`);
          }
          break;
        case "stall":
          newline();
          stderr.write(`分段 ${event.segment} ${event.reason}，换源重试\n`);
          break;
        case "requeue":
          // 自己切分让位给新连接：不是失败，只在 --verbose 下留一行
          if (options.verbose) {
            newline();
            stderr.write(`分段 ${event.segment} 让位给新连接（已下载的字节保留）\n`);
          }
          break;
        case "segment-failed":
          newline();
          if (options.verbose) {
            stderr.write(`分段 ${event.segment} 第 ${event.attempt} 次失败（${event.source}）：${event.error}\n`);
          }
          break;
        case "progress": {
          const now = Date.now();
          // 交互模式每次都刷新；非交互模式按秒输出，避免刷爆 CI 日志
          if (interactive || now - lastLineAt >= 1000) {
            lastLineAt = now;
            writeLine(describeProgress(event));
          }
          break;
        }
        case "warn":
          newline();
          stderr.write(`警告：${event.message}\n`);
          break;
        case "done":
          newline();
          break;
        default:
          break;
      }
    },
    /** 收尾：清掉未换行的进度行。 */
    close() {
      newline();
    },
  };
}

/**
 * 人类可读的结果摘要。
 * @param {any} result
 */
export function formatResult(result) {
  const lines = [];
  lines.push(`完成：${result.out}`);
  lines.push(`大小 ${formatBytes(result.bytes)}，用时 ${formatDuration(result.elapsedSec)}，均速 ${formatBps(result.avgBps)}`);
  if (result.reusedBytes > 0) {
    lines.push(
      `其中复用 ${formatBytes(result.reusedBytes)}（上一轮已下载），本轮实抓 ${formatBytes(result.fetchedBytes)} = ${formatBps(result.fetchBps)}`,
    );
  }
  lines.push(`峰值连接 ${result.peakConns}，来源 ${result.sources}，传输层 ${result.transport}`);
  if (result.mode === "single-stream") lines.push("模式：单流（目标不支持 Range，无法分段与续传）");
  lines.push(`SHA-256 ${result.sha256}`);
  return lines.join("\n");
}
