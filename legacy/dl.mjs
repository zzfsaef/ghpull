#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// dl.mjs —— 多连接分段下载器（PCL 启动器 / aria2 风格）
//
//   固定块队列 + 并发自适应 + 镜像竞速 + 断点续传 + 哈希校验
//
// 2026-10-08 反哺自二代引擎（refs/ghpull）的四处加固：
//   ① 分片长度对账：超过块长的分片**整块丢弃重下**（服务器无视 Range 回 200 整文件时
//      curl -o 会把整份文件写进分片；旧实现把"够大"当"已完成"→ 成品体积超标被末尾校验拦下，
//      同时该分片永远"够大但不完整"，续传/重试都救不回来，只能手删 .parts 目录，而且每次
//      都白下一份整文件）；
//   ② Range 响应校验：要求 206 且 Content-Range 起点与请求一致，否则丢弃该次字节换源重试。
//      这条挡的是**真正的静默损坏**：续传时若某次响应回的区间起点不对（代理/镜像错位），
//      旧实现会把这批错位字节追加进分片，凑够块长后照样判"完成"，成品体积也对得上，
//      只有哈希校验才能发现。
//   ③ 合并前逐块体积校验：宁可明确报错，也不把缺字节的分片悄悄拼成成品；
//   ④ Ctrl-C 立即杀掉在跑的 curl（旧实现只置标志位、且标志位根本没接线），分片保留可续传。
//
// 为什么传输层用 curl.exe 而不是 Node 的 fetch/https：
//   本机 Node 直连 GitHub 报 UNABLE_TO_GET_ISSUER_CERT_LOCALLY（见 AGENTS.md），
//   而 curl.exe 走 Schannel + Windows 证书库 + 系统 hosts/代理，本机实测可用。
//   Node 只负责调度、状态、校验、合并。
//
// 用法：
//   node scripts/dl.mjs <url> [选项]
//     -o, --out <file>      输出文件（默认取 URL 文件名，写到当前目录）
//     --conns <n>           初始并发连接数（默认 8）
//     --max-conns <n>       并发上限（默认 16）
//     --min-chunk <bytes>   最小分块（默认 524288）
//     --timeout <sec>       单次连接超时（默认 15，指 connect-timeout）
//     --retries <n>         每块重试次数（默认 3）
//     -H, --header "K: V"   附加请求头（可重复）
//     --mirror <prefix>     追加镜像前缀（可重复）
//     --no-mirror           只用原始 URL，不探测加速镜像
//     --sha256 <hex>        下完校验 SHA-256，不符则退出码 4
//     --force               允许覆盖已存在的输出文件
//     --json                结束时输出一行 JSON 摘要
//     --quiet               不打印进度
//     --self-test           离线自检（不联网），退出码 0/1
//
// 退出码：0 成功 / 1 用法或网络失败 / 3 拒绝覆盖 / 4 校验失败
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
// 原本是 `import { WS } from "./_paths.mjs";`（工作区路径助手，把相对 --out 解析到工作区根）。
// 这份参照副本不携带工作区文件，改为以当前工作目录为基准，功能等价。
const WS = process.cwd();

const CURL = process.env.DL_CURL || "curl.exe";

const DEFAULTS = {
  conns: 8,
  maxConns: 16,
  minChunk: 512 * 1024,
  timeout: 15,
  retries: 3,
  blocksPerConn: 4,
  probeBytes: 256 * 1024,
  probeMs: 9000,
  sampleMs: 6000,
  stallSec: 25,
};

// ── 镜像候选 ────────────────────────────────────────────────────────────────
// GitHub 直连在本机实测 ~42 KB/s；gh-proxy.com 单连接实测 ~190 KB/s。
// 镜像可用性随时会变，所以这里只提供"候选"，由竞速探测决定用哪个。
const GH_PREFIX_MIRRORS = [
  "https://gh-proxy.com/",
  "https://ghfast.top/",
  "https://ghproxy.net/",
  "https://gh.llkk.cc/",
  "https://github.moeyy.xyz/",
];

/** 由 URL 推导镜像候选（去重、保留原始 URL 在最前） */
export function deriveCandidates(rawUrl, extraMirrors = [], noMirror = false) {
  const out = [rawUrl];
  if (!noMirror) {
    const isGh = /^https:\/\/(github\.com|objects\.githubusercontent\.com|codeload\.github\.com|raw\.githubusercontent\.com)\//.test(rawUrl);
    if (isGh) {
      for (const p of GH_PREFIX_MIRRORS) out.push(p + rawUrl);
      const m = rawUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (m) out.push(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`);
    }
    for (const p of extraMirrors) out.push(/^https?:\/\//.test(p) ? p + rawUrl : p + rawUrl);
  }
  return [...new Set(out)];
}

// ── 分块规划 ────────────────────────────────────────────────────────────────
/** 固定块队列：每块大小 = max(minChunk, ceil(total / (conns*blocksPerConn))) */
export function planBlocks(total, conns, minChunk, blocksPerConn = DEFAULTS.blocksPerConn) {
  if (!Number.isFinite(total) || total <= 0) return [];
  const target = Math.max(minChunk, Math.ceil(total / Math.max(1, conns * blocksPerConn)));
  const blocks = [];
  for (let s = 0; s < total; s += target) {
    blocks.push({ start: s, end: Math.min(s + target - 1, total - 1) });
  }
  return blocks;
}

export function blockLen(b) {
  return b.end - b.start + 1;
}

/** 校验一组块：无重叠、无空洞、总量相符 */
export function blocksCover(blocks, total) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const b of sorted) {
    if (b.start !== cursor) return false;
    if (b.end < b.start) return false;
    cursor = b.end + 1;
  }
  return cursor === total;
}

// ── 杂项 ────────────────────────────────────────────────────────────────────
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function sanitizeName(name) {
  return (name || "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "download.bin";
}

export function nameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const base = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return sanitizeName(base || "download.bin");
  } catch { return "download.bin"; }
}

export function nameFromDisposition(headerValue) {
  if (!headerValue) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(headerValue);
  if (star) { try { return sanitizeName(decodeURIComponent(star[1].trim())); } catch { /* 忽略 */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(headerValue);
  return plain ? sanitizeName(plain[1].trim()) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 反哺自二代引擎（ghpull）的对账工具 ──────────────────────────────────────
/** Ctrl-C 置位；在跑的 curl 会被立刻杀掉，分片留着下次续传 */
let aborted = false;

/** 分块文件名（块区间在计划里是稳定的，所以直接编码两端即可） */
function partFileName(b) {
  return `b-${b.start}-${b.end}.bin`;
}
function partFileOf(partsDir, b) {
  return path.join(partsDir, partFileName(b));
}
function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

/**
 * 分片对账：**以磁盘上的真实字节为准**。
 * 超过期望长度的分片内容不可信（典型来源：服务器无视 Range 回 200 整文件，curl -o 把整份
 * 文件写了进来，其前缀对 start>0 的块来说是别的数据）→ 整块丢弃重下，绝不"夹一下当已完成"。
 * 返回 { have, dropped }，have 永远是 min(磁盘大小, want)。
 */
export function reconcilePartFile(partFile, want) {
  let size = 0;
  try { size = fs.statSync(partFile).size; } catch { return { have: 0, dropped: false }; }
  if (size > want) {
    try { fs.unlinkSync(partFile); } catch { /* 忽略 */ }
    return { have: 0, dropped: true };
  }
  return { have: size, dropped: false };
}

/**
 * 解析 curl -D 抓到的响应头（可能有多次重定向，取最后一个响应块），
 * 判断这次响应是否真的"按 Range 给区间"：必须 206 且 Content-Range 起点 = 请求起点。
 * status === 0 表示没抓到响应头（连接被看门狗杀掉/超时），此时不判死，交给上层按短读重试。
 */
export function parseRangeHeaders(raw, expectStart) {
  const blocks = String(raw || "").split(/\r?\n\r?\n/).filter((b) => /^HTTP\//m.test(b));
  const last = blocks[blocks.length - 1] || "";
  const status = Number((/^HTTP\/[\d.]+ (\d+)/m.exec(last) || [])[1] || 0);
  const cr = /^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)/im.exec(last);
  const from = cr ? Number(cr[1]) : null;
  const to = cr ? Number(cr[2]) : null;
  const total = cr && cr[3] !== "*" ? Number(cr[3]) : null;
  return { status, from, to, total, ok: status === 206 && from === expectStart };
}

// ── curl 调用（不用管道，避免受限沙箱下 spawn 捕获输出报 EPERM）──────────────
/**
 * 跑一次 curl。
 *
 * **为什么自己看门狗，而不是只靠 curl 的 --speed-limit**：实测（2026-10-08，gh-proxy 镜像）
 * 10 条并发连接里有 3~4 条在**零字节**状态下挂了 98 秒以上，`--speed-limit 2048 --speed-time 20`
 * 完全没有触发生效（curl 的速率门限只在有传输活动时才结算），这些僵尸连接白占并发额度。
 * 所以这里自己盯**输出文件**有没有长大：连续 stallSec 秒没有新增字节就杀掉子进程，
 * 上层据此换镜像重试。传 watchFile = null 时退化为「只等 curl 自己结束」。
 */
function runCurl(args, { watchFile = null, stallSec = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CURL, args, { stdio: "ignore", windowsHide: true });
    const tickMs = 2000;
    let timer = null;
    let stalled = false;
    let lastSize = -1;
    let idleMs = 0;
    if (watchFile && stallSec > 0) {
      timer = setInterval(() => {
        let size = -1;
        try { size = fs.statSync(watchFile).size; } catch { size = -1; }
        if (size > lastSize) { lastSize = size; idleMs = 0; } else { idleMs += tickMs; }
        if (idleMs >= stallSec * 1000 && !stalled) {
          stalled = true;
          try { child.kill(); } catch { /* 忽略 */ }
        }
      }, tickMs);
      if (timer.unref) timer.unref();
    }
    let settled = false;
    let killedForAbort = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (abortTimer) clearInterval(abortTimer);
      resolve({ code, error, stalled, aborted: killedForAbort });
    };
    // 反哺自二代引擎：取消要**立刻**作用到子进程，不能等本轮 curl 自己结束
    const abortTimer = setInterval(() => {
      if (settled || !aborted) return;
      killedForAbort = true;
      try { child.kill(); } catch { /* 忽略 */ }
    }, 250);
    if (abortTimer.unref) abortTimer.unref();
    child.on("error", (e) => finish(-1, e.message));
    child.on("close", (code) => finish(code));
  });
}

function curlBase(opts, extraHeaders) {
  const a = ["-sS", "-L", "--connect-timeout", String(opts.timeout), "--speed-limit", "2048", "--speed-time", "20"];
  a.push("-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dl.mjs/1.1");
  for (const h of extraHeaders) a.push("-H", h);
  return a;
}

/** HEAD 探测：拿 Content-Length / Accept-Ranges / 文件名；失败返回 null */
async function headProbe(url, opts, headers, tmpDir, tag) {
  const hdrFile = path.join(tmpDir, `hdr-${tag}.txt`);
  const args = [...curlBase(opts, headers), "-I", "-D", hdrFile, "-o", process.platform === "win32" ? "NUL" : "/dev/null", url];
  const r = await runCurl(args);
  if (r.code !== 0 || !fs.existsSync(hdrFile)) return null;
  const raw = fs.readFileSync(hdrFile, "utf8");
  // 取最后一个响应块（跟完重定向后的那一段）
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//m.test(b));
  const last = blocks[blocks.length - 1] || raw;
  const pick = (re) => { const m = re.exec(last); return m ? m[1].trim() : null; };
  const status = Number((/^HTTP\/[\d.]+ (\d+)/m.exec(last) || [])[1] || 0);
  const lenRaw = pick(/^content-length:\s*(\d+)/im);
  const ranges = pick(/^accept-ranges:\s*(\S+)/im);
  const etag = pick(/^etag:\s*(.+)$/im);
  const disp = pick(/^content-disposition:\s*(.+)$/im);
  return {
    status,
    size: lenRaw ? Number(lenRaw) : null,
    acceptRanges: ranges ? /bytes/i.test(ranges) : null,
    etag,
    filename: nameFromDisposition(disp),
  };
}

/** 测速探测：拉 probeBytes 字节（Range），返回 { ok, bps, size, acceptRanges, etag, filename } */
async function speedProbe(url, opts, headers, tmpDir, tag) {
  const bodyFile = path.join(tmpDir, `probe-${tag}.bin`);
  const hdrFile = path.join(tmpDir, `probehdr-${tag}.txt`);
  try { fs.unlinkSync(bodyFile); } catch { /* 忽略 */ }
  const args = [
    ...curlBase(opts, headers),
    "-r", `0-${opts.probeBytes - 1}`,
    "-D", hdrFile, "-o", bodyFile,
    "--max-time", String(Math.ceil(opts.probeMs / 1000)),
    url,
  ];
  const t0 = Date.now();
  const r = await runCurl(args);
  const el = Math.max(1, Date.now() - t0);
  let written = 0;
  try { written = fs.statSync(bodyFile).size; } catch { /* 忽略 */ }
  let status = 0, size = null, acceptRanges = null, etag = null, filename = null;
  try {
    const raw = fs.readFileSync(hdrFile, "utf8");
    const blocks = raw.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//m.test(b));
    const last = blocks[blocks.length - 1] || raw;
    status = Number((/^HTTP\/[\d.]+ (\d+)/m.exec(last) || [])[1] || 0);
    const cr = /^content-range:\s*bytes \d+-\d+\/(\d+)/im.exec(last);
    const cl = /^content-length:\s*(\d+)/im.exec(last);
    if (cr) size = Number(cr[1]); else if (cl && status === 200) size = Number(cl[1]);
    const ar = /^accept-ranges:\s*(\S+)/im.exec(last);
    if (ar) acceptRanges = /bytes/i.test(ar[1]);
    const et = /^etag:\s*(.+)$/im.exec(last); if (et) etag = et[1].trim();
    const dp = /^content-disposition:\s*(.+)$/im.exec(last); if (dp) filename = nameFromDisposition(dp[1]);
  } catch { /* 忽略 */ }
  // 206 = 支持 Range；200 = 服务器忽略了 Range，整文件在往下灌
  const rangeOk = status === 206;
  if (status === 200 && acceptRanges === null) acceptRanges = false;
  return {
    url, ok: r.code === 0 || written > 0,
    bps: written / (el / 1000),
    written, status,
    size, acceptRanges: rangeOk ? true : acceptRanges, etag, filename,
    exitCode: r.code,
  };
}

// ── 状态持久化（断点续传）────────────────────────────────────────────────────
export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function saveState(file, state) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

// ── 单块下载（含块内续传 + 重试 + 换镜像）─────────────────────────────────────
async function fetchBlock(block, ctx) {
  const partFile = partFileOf(ctx.partsDir, block);
  const want = blockLen(block);
  // 以磁盘上的真实字节为准：超过 want 的分片一律先夹回 want（见文件头 ①）
  let have = reconcilePartFile(partFile, want).have;
  if (have >= want) return { ok: true, bytes: want, resumed: true };

  const attempts = Math.max(1, ctx.opts.retries);
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    if (aborted) return { ok: false, bytes: have, error: "已取消" };
    const mirror = ctx.pickMirror(i);
    have = reconcilePartFile(partFile, want).have;
    if (have >= want) return { ok: true, bytes: want, resumed: true };
    const from = block.start + have;
    // 已续传过 → 先写到临时文件再追加，保证 curl 的 -o 不会截断已有数据
    const target = have > 0 ? partFile + ".inc" : partFile;
    if (have > 0) { try { fs.unlinkSync(target); } catch { /* 忽略 */ } }
    const hdrFile = path.join(ctx.partsDir, `h-${block.start}-${block.end}.hdr`);
    try { fs.unlinkSync(hdrFile); } catch { /* 忽略 */ }
    const args = [
      ...curlBase(ctx.opts, ctx.headers),
      "-r", `${from}-${block.end}`,
      "-D", hdrFile,
      "-o", target,
      mirror,
    ];
    const r = await runCurl(args, { watchFile: target, stallSec: ctx.opts.stallSec });
    if (r.aborted) return { ok: false, bytes: reconcilePartFile(partFile, want).have, error: "已取消" };
    // 必须确认服务器真的按 Range 回话（见文件头 ②）：没抓到响应头说明连接被看门狗杀了
    // 或超时，这种情况不判死，留到下面对账/重试；抓到就必须是 206 且起点相符。
    const range = parseRangeHeaders(readText(hdrFile), from);
    if (range.status !== 0 && !range.ok) {
      try { fs.unlinkSync(target); } catch { /* 忽略 */ }
      lastErr = range.status === 206
        ? `Range 起点不符：请求 ${from}-${block.end}，服务器回 ${range.from}-${range.to}`
        : `服务器未按 Range 响应（HTTP ${range.status}）`;
      ctx.noteError(lastErr);
      await sleep(Math.min(4000, 500 * (i + 1)));
      continue;
    }
    let got = 0;
    try { got = fs.statSync(target).size; } catch { got = 0; }
    if (have > 0 && got > 0) {
      await pipeline(fs.createReadStream(target), fs.createWriteStream(partFile, { flags: "a" }));
      try { fs.unlinkSync(target); } catch { /* 忽略 */ }
    }
    // 关流后对账：回 206 也可能多给字节 → 该分片不可信，丢弃重下
    const rec = reconcilePartFile(partFile, want);
    const now = rec.have;
    if (now >= want) return { ok: true, bytes: want };
    if (rec.dropped) {
      lastErr = `收到的字节超出块长 ${want}，该分片已丢弃重下`;
      ctx.noteError(lastErr);
      await sleep(Math.min(4000, 500 * (i + 1)));
      continue;
    }
    if (r.stalled) {
      lastErr = `停滞 ${ctx.opts.stallSec}s 无新增字节（已杀进程换源）`;
    } else if (r.code === 0) {
      // curl 正常退出但字节不够 —— 服务器提前断流，重试
      if (now >= want) return { ok: true, bytes: want };
      lastErr = `短读 ${now}/${want}`;
    } else {
      lastErr = `curl 退出码 ${r.code}${r.error ? " (" + r.error + ")" : ""}`;
    }
    ctx.noteError(lastErr);
    await sleep(Math.min(4000, 500 * (i + 1)));
  }
  return { ok: false, bytes: reconcilePartFile(partFile, want).have, error: lastErr };
}

// ── 顺序合并分块 ────────────────────────────────────────────────────────────
export async function concatParts(partsDir, blocks, outFile) {
  const tmp = outFile + ".dlmerge";
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  // 合并前逐块对账（见文件头 ③）：宁可在这里明确报错，也别把缺字节的分片悄悄拼成成品。
  for (const b of sorted) {
    const pf = partFileOf(partsDir, b);
    const want = blockLen(b);
    let got = 0;
    try { got = fs.statSync(pf).size; } catch { got = 0; }
    if (got !== want) throw new Error(`分片 ${path.basename(pf)} 大小不符：磁盘上 ${got} 字节，应为 ${want} 字节`);
  }
  const ws = fs.createWriteStream(tmp);
  // 注意：不要对同一个 ws 反复调用 pipeline(.., {end:false})——每调一次就多挂一份
  // error/close 监听器，块一多就触发 MaxListenersExceededWarning。手写背压循环。
  for (const b of sorted) {
    const rs = fs.createReadStream(partFileOf(partsDir, b));
    for await (const chunk of rs) {
      if (!ws.write(chunk)) await once(ws, "drain");
    }
  }
  await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
  fs.renameSync(tmp, outFile);
  return outFile;
}

export function sha256File(file, onChunk) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => { h.update(c); if (onChunk) onChunk(); });
    rs.on("error", reject);
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = {
    url: null, out: null, conns: DEFAULTS.conns, maxConns: DEFAULTS.maxConns,
    minChunk: DEFAULTS.minChunk, timeout: DEFAULTS.timeout, retries: DEFAULTS.retries,
    blocksPerConn: DEFAULTS.blocksPerConn, probeBytes: DEFAULTS.probeBytes,
    probeMs: DEFAULTS.probeMs, sampleMs: DEFAULTS.sampleMs, stallSec: DEFAULTS.stallSec,
    headers: [], mirrors: [], noMirror: false, sha256: null, force: false,
    json: false, quiet: false, selfTest: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} 缺少取值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-o": case "--out": o.out = need(i, a); i++; break;
      case "--conns": o.conns = Number(need(i, a)); i++; break;
      case "--max-conns": o.maxConns = Number(need(i, a)); i++; break;
      case "--min-chunk": o.minChunk = Number(need(i, a)); i++; break;
      case "--timeout": o.timeout = Number(need(i, a)); i++; break;
      case "--retries": o.retries = Number(need(i, a)); i++; break;
      case "--probe-bytes": o.probeBytes = Number(need(i, a)); i++; break;
      case "--probe-ms": o.probeMs = Number(need(i, a)); i++; break;
      case "--sample-ms": o.sampleMs = Number(need(i, a)); i++; break;
      case "--stall-sec": o.stallSec = Number(need(i, a)); i++; break;
      case "-H": case "--header": o.headers.push(need(i, a)); i++; break;
      case "--mirror": o.mirrors.push(need(i, a)); i++; break;
      case "--sha256": o.sha256 = String(need(i, a)).toLowerCase(); i++; break;
      case "--no-mirror": o.noMirror = true; break;
      case "--force": o.force = true; break;
      case "--json": o.json = true; break;
      case "--quiet": o.quiet = true; break;
      case "--self-test": o.selfTest = true; break;
      case "-h": case "--help": o.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`未知选项 ${a}`);
        if (!o.url) o.url = a; else o.extraUrls = [...(o.extraUrls || []), a];
    }
  }
  for (const k of ["conns", "maxConns", "minChunk", "timeout", "retries", "probeBytes", "probeMs", "sampleMs", "stallSec"]) {
    if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`${k} 必须是正数`);
  }
  if (o.maxConns < o.conns) o.maxConns = o.conns;
  return o;
}

const HELP = `dl.mjs —— 多连接分段下载器

  node scripts/dl.mjs <url> [-o 文件] [--conns 8] [--max-conns 16]
       [--min-chunk 524288] [--timeout 15] [--retries 3] [--stall-sec 25]
       [-H "K: V"] [--mirror 前缀] [--no-mirror]
       [--sha256 HEX] [--force] [--json] [--quiet]
  node scripts/dl.mjs --self-test     # 离线自检，不联网

  --stall-sec N  单个连接连续 N 秒零新增字节就杀掉换源（默认 25）
退出码：0 成功 / 1 失败 / 3 拒绝覆盖 / 4 校验失败`;

// ── CLI 主流程 ──────────────────────────────────────────────────────────────
async function realMain(opts) {
  // 0) 覆盖保护：给了 -o 就在**联网之前**拒绝（省掉一轮无谓的竞速探测）。
  //    没给 -o 时文件名要等探测出 Content-Disposition 才知道，只能等第 2 步之后再判。
  if (opts.out) {
    const early = path.resolve(WS, opts.out);
    if (fs.existsSync(early) && !opts.force) {
      process.stderr.write(`拒绝覆盖已存在的文件：${early}\n  确要覆盖请加 --force\n`);
      return 3;
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-probe-"));
  const t0 = Date.now();
  const host = (() => { try { return new URL(opts.url).host; } catch { return "?"; } })();
  const say = (s) => { if (!opts.quiet && !opts.json) process.stdout.write(s + "\n"); };

  // 1) 竞速探测
  const candidates = deriveCandidates(opts.url, opts.mirrors, opts.noMirror);
  say(`→ 目标 ${opts.url}`);
  say(`  主机 ${host}，候选源 ${candidates.length} 个，开始竞速探测…`);
  const probes = await Promise.all(
    candidates.slice(0, 8).map((u, i) => speedProbe(u, opts, opts.headers, tmpDir, String(i)))
  );
  const alive = probes.filter((p) => p.ok && p.written > 4096);
  if (!alive.length) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`全部候选源探测失败：${probes.map((p) => `${shortHost(p.url)}=${p.status || p.exitCode}`).join(", ")}`);
  }
  alive.sort((a, b) => b.bps - a.bps);
  const best = alive[0];
  const usable = alive.filter((p) => p.bps >= best.bps * 0.5);
  if (!opts.quiet && !opts.json) {
    for (const p of alive) say(`    ${shortHost(p.url).padEnd(34)} ${formatBytes(p.bps)}/s${p === best ? "  ← 最快" : ""}`);
    if (usable.length > 1) say(`  并行使用 ${usable.length} 个源分摊分块`);
  }

  // 2) 尺寸 / Range 支持
  let total = best.size;
  let acceptRanges = best.acceptRanges !== false;
  let filename = best.filename;
  if (!total || total <= 0) {
    const hp = await headProbe(best.url, opts, opts.headers, tmpDir, "final");
    if (hp) { total = hp.size; if (hp.acceptRanges !== null) acceptRanges = hp.acceptRanges; filename = filename || hp.filename; }
  }
  if (!total || total <= 0) acceptRanges = false; // 无 Content-Length（分块传输）→ 只能单流

  const outFile = path.resolve(WS, opts.out || filename || nameFromUrl(opts.url));
  const partsDir = path.join(path.dirname(outFile), `.${path.basename(outFile)}.parts`);

  if (fs.existsSync(outFile) && !opts.force) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.stderr.write(`拒绝覆盖已存在的文件：${outFile}\n  确要覆盖请加 --force\n`);
    return 3;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(partsDir, { recursive: true });

  const stateFile = path.join(partsDir, "state.json");

  let peakConns = 1;
  let reusedBytes = 0;
  let mode = "分段";
  if (acceptRanges && total > 0 && total > opts.minChunk) {
    const blocksAll = planBlocks(total, opts.conns, opts.minChunk, opts.blocksPerConn);
    if (!blocksCover(blocksAll, total)) throw new Error("分块规划自检失败：块之间有空洞或重叠");

    // 断点续传：只有 size/etag 都对得上的"已完成块"才复用
    const st = loadState(stateFile);
    const sameFile = !!(st && st.size === total && (st.etag || null) === (best.etag || null));
    const stDone = new Set(sameFile ? (st.done || []).map((b) => `${b.start}-${b.end}`) : []);
    const completeBlock = (b) => {
      const f = partFileOf(partsDir, b);
      try { return fs.statSync(f).size === blockLen(b); } catch { return false; }
    };
    const pending = blocksAll.filter((b) => !(stDone.has(`${b.start}-${b.end}`) && completeBlock(b)));
    const reuse = blocksAll.filter((b) => !pending.includes(b));
    const downloadedBase = reuse.reduce((s, b) => s + blockLen(b), 0);
    reusedBytes = downloadedBase;
    if (reuse.length) say(`  断点续传：复用 ${reuse.length} 个已完成分块（${formatBytes(downloadedBase)}）`);

    let lastLine = "";
    const draw = (done, tot, lim) => {
      if (opts.quiet || opts.json) return;
      const el = (Date.now() - t0) / 1000;
      const bps = done / Math.max(0.001, el);
      const pct = tot ? (done / tot) * 100 : 0;
      const eta = bps > 0 && tot ? Math.max(0, (tot - done) / bps) : 0;
      const line = `  ${pct.toFixed(1)}%  ${formatBytes(done)}/${formatBytes(tot)}  ${formatBytes(bps)}/s  并发≤${lim}  ETA ${eta.toFixed(0)}s`;
      if (line !== lastLine) { process.stdout.write("\r" + line.padEnd(96)); lastLine = line; }
    };

    const ctx = {
      total, conns: opts.conns, maxConns: opts.maxConns, opts, headers: opts.headers,
      partsDir, etag: best.etag,
      pickMirror: (i) => usable[(i + mirrorCursor++) % usable.length].url,
      noteError: (m) => { lastErrors.push(m); if (lastErrors.length > 50) lastErrors.shift(); },
      failure: null,
      persist: (done) => saveState(stateFile, { url: opts.url, size: total, etag: best.etag, done }),
      log: (m) => { if (!opts.quiet && !opts.json) process.stdout.write(m + "\n"); },
      draw,
    };
    const result = await runQueue({ ...ctx, queueBlocks: pending, downloadedBase });
    peakConns = result.peakConns;
    if (!opts.quiet && !opts.json) process.stdout.write("\n");
    const parts = [...reuse, ...result.blocks];
    say(`  分段完成，合并 ${parts.length} 块…`);
    await concatParts(partsDir, parts, outFile);
  } else {
    // 单流兜底：不支持 Range，或没有 Content-Length（分块传输）
    mode = "单流";
    say("  服务器不支持 Range 或无 Content-Length → 单流下载（仍带断点续传）");
    const single = outFile + ".partial";
    const args = [...curlBase(opts, opts.headers)];
    const have = fs.existsSync(single) ? fs.statSync(single).size : 0;
    reusedBytes = have;
    if (have > 0) { say(`  发现半成品 ${path.basename(single)}（${formatBytes(have)}），续传…`); args.push("-C", "-"); }
    args.push("-o", single, best.url);
    const r = await runCurl(args, { watchFile: single, stallSec: opts.stallSec });
    if (r.aborted) throw new Error("已取消（半成品已保留，可直接重跑续传）");
    if (r.stalled) throw new Error(`单流下载停滞 ${opts.stallSec}s 无新增字节（已杀进程）`);
    if (r.code !== 0) throw new Error(`单流下载失败，curl 退出码 ${r.code}`);
    fs.renameSync(single, outFile);
  }

  // 3) 校验
  const size = fs.statSync(outFile).size;
  if (total > 0 && size !== total) throw new Error(`输出体积不符：期望 ${total}，实际 ${size}`);
  let digest = null;
  if (opts.sha256) {
    say("  计算 SHA-256…");
    digest = await sha256File(outFile);
    if (digest !== opts.sha256) {
      process.stderr.write(`SHA-256 不符：\n  期望 ${opts.sha256}\n  实际 ${digest}\n`);
      return 4;
    }
  }
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const el = (Date.now() - t0) / 1000;
  // 注意：续传时 size 里有一部分是**上一轮就已经下好、这次直接复用**的字节。
  // 拿 size÷elapsed 当"网速"会虚高，所以两个口径分开报：avgBps=端到端，fetchBps=本轮真抓的。
  const fetched = Math.max(0, size - reusedBytes);
  const summary = {
    ok: true, url: opts.url, out: outFile, bytes: size, mode,
    elapsedSec: Number(el.toFixed(2)),
    avgBps: Math.round(size / Math.max(0.001, el)),
    reusedBytes, fetchedBytes: fetched,
    fetchBps: Math.round(fetched / Math.max(0.001, el)),
    peakConns, sources: usable.length, sha256: digest,
  };
  if (opts.json) process.stdout.write(JSON.stringify(summary) + "\n");
  else {
    say(`✓ ${outFile}`);
    say(`  ${formatBytes(size)} / ${el.toFixed(1)}s = ${formatBytes(summary.avgBps)}/s，峰值并发 ${peakConns}，模式 ${mode}`);
    if (reusedBytes > 0) say(`  其中复用 ${formatBytes(reusedBytes)}（上一轮的），本轮实抓 ${formatBytes(fetched)} = ${formatBytes(summary.fetchBps)}/s`);
  }
  return 0;
}

let mirrorCursor = 0;
let lastErrors = [];
const shortHost = (u) => { try { const x = new URL(u); return x.host + (x.pathname.length > 12 ? "…" + x.pathname.slice(-10) : x.pathname); } catch { return u; } };

/** 队列执行器（支持续传已完成块） */
async function runQueue(ctx) {
  const queue = [...ctx.queueBlocks];
  const done = [];
  let inflight = 0;
  let limit = Math.min(ctx.conns, ctx.maxConns);
  let peak = 0;
  let stopped = false;
  let downloaded = ctx.downloadedBase || 0;
  const total = ctx.total;

  const samples = [];
  let lastBytes = downloaded, lastT = Date.now();
  const monitor = setInterval(() => {
    const now = Date.now(); const el = (now - lastT) / 1000;
    if (el <= 0) return;
    const bps = (downloaded - lastBytes) / el;
    lastBytes = downloaded; lastT = now;
    samples.push(bps);
    if (samples.length >= 2 && limit < ctx.maxConns) {
      const prev = samples[samples.length - 2], cur = samples[samples.length - 1];
      if (prev > 0 && cur > prev * 1.05) { limit = Math.min(ctx.maxConns, limit + 2); ctx.log(`  ↻ 吞吐上升 → 并发提到 ${limit}`); }
    } else if (samples.length >= 2 && limit > 2) {
      const prev = samples[samples.length - 2], cur = samples[samples.length - 1];
      if (prev > 0 && cur < prev * 0.85) { limit = Math.max(2, limit - 2); ctx.log(`  ↻ 吞吐下降 → 并发降到 ${limit}`); }
    }
    ctx.draw(downloaded, total, limit);
  }, ctx.opts.sampleMs);

  const worker = async (id) => {
    while (!stopped) {
      if (id >= limit || queue.length === 0) {
        if (inflight === 0 && queue.length === 0) return;
        await sleep(80);
        continue;
      }
      const block = queue.shift();
      inflight++;
      if (inflight > peak) peak = inflight;
      const r = await fetchBlock(block, ctx);
      inflight--;
      if (r.ok) {
        downloaded += blockLen(block);
        done.push(block);
        ctx.persist(done);
        ctx.draw(downloaded, total, limit);
      } else {
        stopped = true;
        ctx.failure = `${block.start}-${block.end}: ${r.error}`;
        return;
      }
    }
  };

  const pool = [];
  for (let i = 0; i < ctx.maxConns; i++) pool.push(worker(i));
  ctx.draw(downloaded, total, limit);
  await Promise.all(pool);
  clearInterval(monitor);
  if (ctx.failure) throw new Error("分段下载失败：" + ctx.failure);
  if (downloaded !== total) throw new Error(`字节数不符：期望 ${total}，实际 ${downloaded}`);
  return { blocks: done, peakConns: peak };
}

// ── 离线自检（含双向对照组）──────────────────────────────────────────────────
async function selfTest() {
  const out = [];
  let pass = 0, fail = 0;
  const check = (name, ok, detail = "") => {
    out.push(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  (" + detail + ")" : ""}`);
    ok ? pass++ : fail++;
  };

  // 1) 分块规划：无空洞、无重叠、总量相符
  for (const [total, conns, minChunk] of [[1000, 4, 64], [10 * 1048576, 8, 524288], [1, 8, 524288], [999999, 16, 1024]]) {
    const b = planBlocks(total, conns, minChunk);
    check(`planBlocks(${total},${conns},${minChunk}) 完整覆盖`, blocksCover(b, total), `${b.length} 块`);
  }
  // 2) 块大小不超过 minChunk 之外的上限，且不小于 minChunk（除尾块）
  {
    const total = 10 * 1048576, b = planBlocks(total, 8, 524288);
    const ok = b.slice(0, -1).every((x) => blockLen(x) >= 524288 && blockLen(x) <= Math.max(524288, Math.ceil(total / 32)));
    check("块大小落在 [minChunk, total/(conns*bpc)]", ok, `首块 ${blockLen(b[0])}`);
  }
  // 3) 镜像候选
  {
    const c = deriveCandidates("https://github.com/a/b/releases/download/v1/x.zip");
    check("GitHub URL 推导出镜像候选", c.length > 1 && c[0].startsWith("https://github.com/"), `${c.length} 个`);
    const c2 = deriveCandidates("https://example.com/x.zip");
    check("非 GitHub URL 不凭空造镜像", c2.length === 1, `${c2.length} 个`);
    const c3 = deriveCandidates("https://github.com/a/b/releases/download/v1/x.zip", [], true);
    check("--no-mirror 只留原始 URL", c3.length === 1 && c3[0].includes("github.com"), `${c3.length} 个`);
    const c4 = deriveCandidates("https://raw.githubusercontent.com/o/r/main/d/f.txt");
    check("raw.githubusercontent 推导 jsdelivr 候选", c4.some((u) => u.includes("cdn.jsdelivr.net/gh/o/r@main/d/f.txt")), `${c4.length} 个`);
  }
  // 4) 文件名解析
  check("nameFromUrl 取路径末段", nameFromUrl("https://x.com/a/b/c.tar.gz") === "c.tar.gz");
  check("Content-Disposition 解析", nameFromDisposition('attachment; filename="ok.zip"') === "ok.zip");
  check("非法字符被替换", !/[\\/:*?"<>|]/.test(sanitizeName('a/b\\c:d*e?f"g<h>i|j')));
  // 5) 状态读写往返
  {
    const f = path.join(os.tmpdir(), `dl-selftest-${process.pid}.json`);
    const st = { url: "u", size: 12, etag: "e", done: [{ start: 0, end: 5 }] };
    saveState(f, st);
    const back = loadState(f);
    check("状态存取往返一致", JSON.stringify(back) === JSON.stringify(st));
    fs.unlinkSync(f);
  }
  // 6) 合并 + 哈希（真写文件、真读回）
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dl-merge-"));
    const parts = [{ start: 0, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 5 }];
    fs.writeFileSync(path.join(d, "b-0-2.bin"), "abc");
    fs.writeFileSync(path.join(d, "b-3-4.bin"), "de");
    fs.writeFileSync(path.join(d, "b-5-5.bin"), "f");
    const outF = path.join(d, "out.txt");
    await concatParts(d, [...parts].reverse(), outF); // 乱序传入也要按 start 合并
    const content = fs.readFileSync(outF, "utf8");
    check("concatParts 乱序输入按 start 合并", content === "abcdef", JSON.stringify(content));
    const h = await sha256File(outF);
    const expect = crypto.createHash("sha256").update("abcdef").digest("hex");
    check("sha256File 与 node:crypto 一致", h === expect, h.slice(0, 12));
    // 对照：故意给一个错的期望哈希，必须判为不等
    const wrong = "0".repeat(64);
    check("对照组：错误哈希被判为不等", h !== wrong);
    fs.rmSync(d, { recursive: true, force: true });
  }
  // 7) 参数解析（含拒绝行为）
  {
    const o = parseArgs(["https://x/y", "-o", "z", "--conns", "4", "--force"]);
    check("parseArgs 正常解析", o.url === "https://x/y" && o.out === "z" && o.conns === 4 && o.force === true);
    let threw = false;
    try { parseArgs(["https://x/y", "--conns", "0"]); } catch { threw = true; }
    check("parseArgs 拒绝非法并发数", threw);
    let threw2 = false;
    try { parseArgs(["https://x/y", "--nope"]); } catch { threw2 = true; }
    check("parseArgs 拒绝未知选项", threw2);
  }

  // 8) 反哺自二代引擎（ghpull）的三处对账（离线，真写文件）
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dl-recon-"));
    const f = path.join(d, "b-0-3.bin");
    fs.writeFileSync(f, "0123456789"); // 10 字节 > 块长 4
    const rec = reconcilePartFile(f, 4);
    check("对账：超长分片整块丢弃（内容不可信）", rec.have === 0 && rec.dropped === true && !fs.existsSync(f), `have=${rec.have}`);
    fs.writeFileSync(f, "012");
    const rec2 = reconcilePartFile(f, 4);
    check("对账：不足的分片原样保留（留给续传）", rec2.have === 3 && rec2.dropped === false, `have=${rec2.have}`);
    const r206 = parseRangeHeaders("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 100-199/1000\r\n\r\n", 100);
    check("Range 校验：206 且起点相符 → 通过", r206.ok === true, `${r206.from}-${r206.to}/${r206.total}`);
    const r200 = parseRangeHeaders("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n", 100);
    check("Range 校验：200 整文件 → 拒绝（防静默损坏）", r200.ok === false, `status=${r200.status}`);
    const rStart = parseRangeHeaders("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-99/1000\r\n\r\n", 100);
    check("Range 校验：206 但起点不符 → 拒绝", rStart.ok === false, `from=${rStart.from}`);
    const rNone = parseRangeHeaders("", 100);
    check("Range 校验：没抓到响应头（被看门狗杀掉）→ 不判死", rNone.status === 0 && rNone.ok === false, "status=0");
    // 合并前的逐块体积校验：故意少写字节
    fs.writeFileSync(path.join(d, "b-4-7.bin"), "xxx");
    let mergeThrew = false;
    try { await concatParts(d, [{ start: 0, end: 3 }, { start: 4, end: 7 }], path.join(d, "o.bin")); } catch { mergeThrew = true; }
    check("合并前拒绝长度不符的分片", mergeThrew === true);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log(`dl.mjs 离线自检：通过 ${pass} / 失败 ${fail}`);
  for (const l of out) console.log(l);
  return fail === 0 ? 0 : 1;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
async function main() {
  // Ctrl-C / 终止信号：只置标志位并杀掉在跑的 curl（见文件头 ④），不动已经下好的分片
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (aborted) return;
      aborted = true;
      process.stderr.write("\n已取消：正在停掉在跑的连接（分片保留，直接重跑即可续传）\n");
    });
  }
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(String(e.message) + "\n"); return 1; }
  if (opts.help || (!opts.url && !opts.selfTest)) { process.stdout.write(HELP + "\n"); return opts.help ? 0 : 1; }
  if (opts.selfTest) return selfTest();
  const urls = [opts.url, ...(opts.extraUrls || [])];
  let last = 0;
  for (let i = 0; i < urls.length; i++) {
    const one = { ...opts, url: urls[i], extraUrls: undefined, out: null };
    // 多个 URL 时 -o 只对第一个生效（避免互相覆盖）
    if (i === 0) one.out = opts.out;
    try { last = await realMain(one); }
    catch (e) { process.stderr.write("✗ " + String(e.message) + "\n"); return 1; }
    if (last !== 0) return last;
  }
  return last;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
}

export { realMain, selfTest, DEFAULTS };
