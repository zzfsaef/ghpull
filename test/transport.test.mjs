// SPDX-License-Identifier: MIT
/**
 * 传输层测试：`openRange` / `probe` 在 node 与 curl 两条路径上的行为。
 *
 * 为什么专门测这一层：node 与 curl 是同一条链路上两个完全不同的实现——node 侧自己
 * 跟随跳转、自己解析响应头，curl 侧把这一切交给命令行工具再回头解析 `--dump-header`
 * 文件。分片下载最难查的故障（跳转后拿到错字节、服务端撒谎、边界算错、取消被当成
 * 成功、凭据跟着跳转跑到别的站点）全都落在这里，所以把「跳转链」「416」「服务端
 * 撒谎」「不支持 Range」「字节数对账」「跨 origin 凭据」「错误如实上报」几类畸形
 * 响应钉死。
 *
 * 全部用例只打 127.0.0.1 上的本地服务，离线可跑。
 *
 * ## 为什么 curl 用例要用「另一个进程」里的服务
 *
 * curl 用例不共用 `helpers.mjs` 的 `startServer()`，而是把服务放到**子进程**里起
 * （见下面的 `spawnRangeServer`）。原因不是洁癖：本机实测，本进程 spawn 出来的 curl
 * **连不上本进程自己监听的 127.0.0.1 端口**（curl 报 `(28) Operation timed out ...
 * with 0 bytes received`，服务端一个请求都收不到），而 curl 打另一个**独立进程**监听
 * 的回环端口完全正常。所以在「测试进程自己起服务 + 同一进程里 spawn curl」这种写法下，
 * curl 侧永远拿不到响应，测出来的全是假失败。服务放进子进程后两边在同一层级，curl
 * 路径才能被真正跑到。
 *
 * ## curl 用例为什么会动态跳过
 *
 * 上面那条限制是**环境层**的：换台机器（例如 CI）可能压根不存在。所以依赖 curl 的
 * 用例在跑之前先做一次能力探测（`canCurlLoopback()`，结果缓存、只探测一次），探测
 * 失败才 `t.skip()`，绝不用放宽断言的方式「绕过去」。探测本身覆盖两种拓扑：同进程
 * 服务与子进程服务，任一条通得过就算 curl 可用。
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import process from "node:process";

import { GhpullError, SourceError, UnsupportedError } from "../src/errors.mjs";
import {
  closeAgents,
  detectCurl,
  filenameFromHeaders,
  openRange,
  parseContentRange,
  parseHeaderFile,
  probe,
} from "../src/transport.mjs";
import { makeBody, makeTempDir, startServer } from "./helpers.mjs";

/** 本机 curl 探测结果；null 表示这台机器上没有可用的 curl。 */
const curl = /** @type {{path: string, version: string}|null} */ (detectCurl());

/** 没有 curl 的机器：依赖 curl 的用例整条跳过，而不是把套件染红。 */
const NO_CURL = curl === null ? "本机没有可用的 curl（detectCurl() 返回 null）" : false;

/** 依赖 curl 的用例跳过时用的说明（只在能力探测失败时出现）。 */
const NO_CURL_LOOPBACK = "本机 curl 无法访问 127.0.0.1（环境层拦截），CI 上会真跑";

/** curl 打回环地址时丢弃响应体的落点（Windows 上没有 /dev/null）。 */
const NULL_SINK = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 注册一个需要 curl 的用例。
 *
 * 跳过判定必须发生在**用例体内**：能力探测要 spawn 一个子进程服务，只能异步做，
 * 而 `test(name, { skip })` 的选项是在模块加载时同步求值的。所以这里先按「有没有
 * curl」静态跳过，再在体内按探测结果动态跳过。
 * @param {string} name
 * @param {(t: import("node:test").TestContext) => Promise<void>} fn
 */
function curlTest(name, fn) {
  test(name, { skip: NO_CURL }, async (t) => {
    if (!(await canCurlLoopback())) {
      t.skip(NO_CURL_LOOPBACK);
      return;
    }
    await fn(t);
  });
}

/**
 * 用 curl 取一个 URL，问「它到底连上并拿到响应了吗」。
 * @param {string} url
 * @param {number} timeoutSec
 */
function curlReaches(url, timeoutSec) {
  const result = spawnSync(
    /** @type {{path: string}} */ (curl).path,
    ["--silent", "--show-error", "--max-time", String(timeoutSec), "--output", NULL_SINK, url],
    { encoding: "utf8", timeout: (timeoutSec + 5) * 1000, windowsHide: true },
  );
  return result.status === 0;
}

/** 拓扑一：服务跑在**本进程**里，curl 是子进程。 */
async function curlReachesSameProcessServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-length": "2" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    return curlReaches(`http://127.0.0.1:${address.port}/probe`, 3);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/** 拓扑二：服务跑在**子进程**里——这正是所有 curl 用例实际使用的形态。 */
async function curlReachesChildProcessServer() {
  const temp = await makeTempDir();
  const script = temp.file("loopback-server.mjs");
  await writeFile(
    script,
    [
      'import http from "node:http";',
      "const server = http.createServer((_req, res) => {",
      '  res.writeHead(200, { "content-length": "2" });',
      '  res.end("ok");',
      "});",
      'server.listen(0, "127.0.0.1", () => console.log("READY " + server.address().port));',
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error("能力探测：子进程服务未就绪")), 15000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = /READY (\d+)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("能力探测：子进程服务提前退出"));
      });
    });
    return curlReaches(`http://127.0.0.1:${port}/probe`, 3);
  } finally {
    child.kill();
    await temp.cleanup();
  }
}

/** @type {Promise<boolean>|null} */
let loopbackProbe = null;

/** 本机 curl 能不能真的把请求送到回环地址上的测试服务（只探测一次，结果缓存）。 */
function canCurlLoopback() {
  if (curl === null) return Promise.resolve(false);
  loopbackProbe ??= (async () => {
    if (await curlReachesSameProcessServer()) return true;
    return curlReachesChildProcessServer();
  })().catch(() => false);
  return loopbackProbe;
}

/**
 * 把「收到的字节和期望的字节差在哪」讲清楚。
 *
 * 分片下载最怕的就是「字节数看着对、内容其实是别的区间」，所以断言失败时不能只说
 * 「不相等」——必须给出首个差异位置、两边各是什么，以及是「截断」还是「整体错位」。
 *
 * @param {Buffer} got
 * @param {Buffer} want
 */
function describeBytesDiff(got, want) {
  if (got.length === want.length && got.equals(want)) return "完全相同";
  const limit = Math.min(got.length, want.length);
  let first = -1;
  for (let index = 0; index < limit; index += 1) {
    if (got[index] !== want[index]) {
      first = index;
      break;
    }
  }
  if (first === -1) {
    return `前缀一致，长度不同：收到 ${got.length}，期望 ${want.length}（截断）`;
  }
  const offset = got.indexOf(want.subarray(0, 32));
  return `首个差异下标 ${first}（收到 ${got[first]}，期望 ${want[first]}），长度 ${got.length}/${want.length}，期望前缀在实收中的偏移 ${offset}`;
}

/**
 * 等一个 Promise 落定，超时则报 `pending`。
 *
 * 为什么不用裸 `await`：这些用例要断言的恰恰是「该 reject 的时候有没有 reject」，
 * 一旦实现改回「错误地 resolve」，裸 await 会让用例直接通过；反过来若实现永不
 * settle，裸 await 会把整个测试文件挂死。所以固定形态 + 超时兜底。
 * @param {Promise<any>} promise
 * @param {number} [timeoutMs]
 * @returns {Promise<{status: "fulfilled", value: any} | {status: "rejected", reason: any} | {status: "pending"}>}
 */
async function settle(promise, timeoutMs = 5000) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: /** @type {const} */ ("fulfilled"), value }),
        (reason) => ({ status: /** @type {const} */ ("rejected"), reason }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: /** @type {const} */ ("pending") }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 收集 `openRange().bytes`，并等 `finished` 落定。
 *
 * 为什么要自己写：`openRange` 只给「能读的流」，真正的完成信号在 `finished` 上——
 * 它代表服务端说好的字节数是否真的收齐（node 侧）或 curl 的退出码是否判定完（curl 侧）。
 * 两个信号分开汇报，避免「迭代器抛没抛」与「finished 报什么」互相掩盖。
 * @param {{bytes: AsyncIterable<Buffer>, finished: Promise<void>}} stream
 */
async function drain(stream) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {unknown} */
  let readError = null;
  try {
    for await (const chunk of stream.bytes) chunks.push(Buffer.from(chunk));
  } catch (error) {
    readError = error;
  }
  const finished = await settle(stream.finished);
  const bytes = Buffer.concat(chunks);
  return { received: bytes.length, bytes, readError, finished };
}

/**
 * 读一段流并断言它正常收尾（成功路径的简写）。
 * @param {{bytes: AsyncIterable<Buffer>, finished: Promise<void>, abort?: () => void}} stream
 */
async function collect(stream) {
  try {
    const result = await drain(stream);
    assert.equal(result.finished.status, "fulfilled", `流本该正常收尾：${describeFinish(result.finished)}`);
    return result.bytes;
  } finally {
    stream.abort?.();
  }
}

/** 把 `finished` 的落定形态写成一句可读的诊断。 */
function describeFinish(result) {
  if (result.status === "fulfilled") return "已完成";
  if (result.status === "pending") return "5s 内既没 resolve 也没 reject（挂死）";
  return `${result.reason?.name ?? "Error"}: ${result.reason?.message ?? result.reason}`;
}

/**
 * 起一个「自定义剧本」的本地服务（同进程版），只给 transport:"node" 的用例用。
 *
 * 为什么不直接用 `startServer()`：它只覆盖几种固定剧本，而跳转链、撒谎的
 * Content-Range、字节数对不上、跨 origin 跳转这些畸形响应需要自己写 handler。
 * 用路径作键，避免调用方散落 `/real` 之类的魔法字符串。
 *
 * @param {Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>} handlers
 */
async function customServer(handlers) {
  let ended = false;
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    // close() 之后 keep-alive 连接上仍可能有迟到请求；直接断掉，别让它砸到已归还的端口
    if (ended || !handlers[path]) {
      res.destroy();
      return;
    }
    handlers[path](req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => {
      ended = true;
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * 起一个会**记录收到了什么请求**的同进程服务。
 *
 * 跨 origin 跳转的用例必须问「对面到底收到了哪些头」，所以服务端得留下证据：
 * 记录方法、路径与完整请求头（判断凭据有没有跟过去，只能靠它）。
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, index: number) => void} handler
 */
async function recordServer(handler) {
  /** @type {{method: string, path: string, headers: Record<string, string|string[]|undefined>}[]} */
  const received = [];
  let ended = false;
  const server = http.createServer((req, res) => {
    if (ended) {
      res.destroy();
      return;
    }
    received.push({
      method: String(req.method ?? ""),
      path: (req.url ?? "/").split("?")[0],
      headers: { ...req.headers },
    });
    handler(req, res, received.length - 1);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${address.port}`,
    received,
    close: () => {
      ended = true;
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * 一个老老实实按请求区间回 206 的处理器（HEAD 回整包信息），供跳转用例复用。
 * @param {Buffer} body
 */
function rangeHandler(body) {
  return (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (!match) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
    });
    res.end(body.subarray(start, end + 1));
  };
}

/**
 * 用字符串把「curl 写坏 / 只写了一半的 --dump-header 文件」落盘喂给 `parseHeaderFile`。
 *
 * 为什么不让本地服务代劳：真 curl 写文件是流式追加的，我们要测的是**读侧**
 * 面对中间态快照时的判定；直接构造字节比试图在真实时间里卡出半截文件可靠得多。
 * @param {{file: (name: string) => string}} temp @param {string} name @param {string} content
 */
async function dumpHeaderFile(temp, name, content) {
  const file = temp.file(name);
  await writeFile(file, content, "utf8");
  return file;
}

test.after(() => closeAgents());

// ---------------------------------------------------------------------------
// curl 用的「另一个进程」服务
// ---------------------------------------------------------------------------

/**
 * 子进程里那个服务的源码。
 *
 * 剧本（handler.kind）：
 * - `range`     按 Range 回 206，越界回 416（常规资源）
 * - `short`     回 206 且 Content-Range 与请求一致，但 body 只发 `sendBytes` 字节
 * - `redirect`  按 `status`/`location` 跳转
 * - `norange`   无视 Range 直接回 200 整包（服务端不支持分段）
 * - `lying`     回 206 但 Content-Range 只声明前 512 字节（服务端撒谎）
 * - `head`      对任何方法都回 200 + Content-Length + Accept-Ranges（探测用）
 * - `static`    按 `status` 原样回整包（用来造 4xx/5xx）
 *
 * 额外声明 `headers` 会并进最终响应头；声明 `echoFile` 会把收到的每个请求
 * 追加进那个文件，让测试能断言「curl 到底发了什么」。
 */
// 注意：下面是**被写进子进程的源码**，整段是模板字符串，里面不能出现反引号，
// 所以这段源码自身的注释一律改用「……」引号，解释性注释留在这个模板外面。
const SERVER_SOURCE = String.raw`
import { appendFile, readFile } from "node:fs/promises";
import http from "node:http";

const config = JSON.parse(await readFile(process.env.GHPULL_TEST_SERVER_CONFIG, "utf8"));
const bodies = {};
for (const [route, spec] of Object.entries(config.handlers)) {
  bodies[route] = spec.bodyFile ? new Uint8Array(await readFile(spec.bodyFile)) : new Uint8Array(0);
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const spec = config.handlers[path];
  if (spec === undefined) {
    res.destroy();
    return;
  }
  const body = bodies[path];
  if (spec.echoFile) {
    void appendFile(spec.echoFile, req.method + " " + path + " range=" + String(req.headers.range ?? "-") + "\n", "utf8");
  }
  run(spec, req, res, body);
});

function rangeOf(req, body) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function run(spec, req, res, body) {
  if (spec.kind === "redirect") {
    res.writeHead(spec.status, { location: spec.location, "content-length": "0", ...(spec.headers ?? {}) });
    res.end();
    return;
  }

  if (spec.kind === "head") {
    const wanted = rangeOf(req, body);
    if (wanted && req.method !== "HEAD") {
      // 探测用的 Range: 0-0：真实支持分段的服务器会回 206，而不是「200 + 整包长度」。
      // 这里刻意不提 content-length（206 由 content-range 描述长度），与真实服务器一致。
      res.writeHead(206, {
        "content-range": "bytes " + wanted.start + "-" + wanted.end + "/" + body.length,
        "accept-ranges": "bytes",
        ...(spec.headers ?? {}),
      });
      res.end(Buffer.from(body.subarray(wanted.start, wanted.end + 1)));
      return;
    }
    res.writeHead(200, {
      "content-length": String(body.length),
      "accept-ranges": spec.acceptRanges ?? "bytes",
      ...(spec.headers ?? {}),
    });
    res.end();
    return;
  }

  if (spec.kind === "norange") {
    res.writeHead(200, { "content-length": String(body.length), "content-type": "application/octet-stream", ...(spec.headers ?? {}) });
    res.end(Buffer.from(body));
    return;
  }

  if (spec.kind === "static") {
    res.writeHead(spec.status ?? 200, { "content-length": String(body.length), ...(spec.headers ?? {}) });
    res.end(Buffer.from(body));
    return;
  }

  if (spec.kind === "lying") {
    res.writeHead(206, { "content-range": "bytes 0-511/" + body.length, "content-length": "512", "accept-ranges": "bytes", ...(spec.headers ?? {}) });
    res.end(Buffer.from(body.subarray(0, 512)));
    return;
  }

  if (spec.kind === "short") {
    const wanted = rangeOf(req, body) ?? { start: 0, end: body.length - 1 };
    const send = Math.min(spec.sendBytes ?? 1, wanted.end - wanted.start + 1);
    // 关键：声明的 Content-Range 与请求区间**一致**，长度也用 Content-Length 说圆，
    // 只是实际发出的字节少——协议层看不出任何异常，只有「数字节」的实现能发现。
    res.writeHead(206, {
      "content-range": "bytes " + wanted.start + "-" + wanted.end + "/" + body.length,
      "content-length": String(send),
      "accept-ranges": "bytes",
      ...(spec.headers ?? {}),
    });
    res.end(Buffer.from(body.subarray(wanted.start, wanted.start + send)));
    return;
  }

  if (spec.kind === "range") {
    const wanted = rangeOf(req, body);
    if (!wanted) {
      res.writeHead(416, { "content-range": "bytes */" + body.length });
      res.end();
      return;
    }
    if (wanted.start >= body.length || wanted.end >= body.length || wanted.start > wanted.end) {
      res.writeHead(416, { "content-range": "bytes */" + body.length });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-range": "bytes " + wanted.start + "-" + wanted.end + "/" + body.length,
      "content-length": String(wanted.end - wanted.start + 1),
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
      ...(spec.headers ?? {}),
    });
    res.end(Buffer.from(body.subarray(wanted.start, wanted.end + 1)));
    return;
  }

  res.destroy();
}

server.listen(0, "127.0.0.1", () => {
  console.log("READY " + server.address().port);
});

process.stdin.resume();
process.stdin.on("close", () => {
  server.close();
  process.exit(0);
});
`;

/**
 * 在子进程里起一个按剧本走的本地服务。
 *
 * 为什么必须开子进程：见文件头「为什么 curl 用例要用另一个进程里的服务」。
 * 临时脚本与响应体都落在 `temp.dir` 里，测试结束一并清掉。
 *
 * @param {number} size 响应体大小（`makeBody` 生成，与服务端联调过的确定性数据）
 * @param {Record<string, {kind: string, status?: number, location?: string, sendBytes?: number,
 *   headers?: Record<string, string>, echoFile?: string}>} handlers
 * @param {{body?: Buffer}} [options] `body`：直接指定响应体，不指定就用 `makeBody(size)`
 */
async function spawnRangeServer(size, handlers, options = {}) {
  const temp = await makeTempDir();
  const script = temp.file("server.mjs");
  await writeFile(script, SERVER_SOURCE, "utf8");

  for (const [route, spec] of Object.entries(handlers)) {
    if (["range", "norange", "lying", "head", "short", "static"].includes(spec.kind)) {
      const bodyFile = temp.file(`body-${route.replace(/[^\w]+/g, "_")}.bin`);
      await writeFile(bodyFile, options.body ?? makeBody(size));
      Object.assign(spec, { bodyFile });
    }
  }

  const configFile = temp.file("config.json");
  await writeFile(configFile, JSON.stringify({ handlers }), "utf8");

  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GHPULL_TEST_SERVER_CONFIG: configFile },
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程服务未就绪；stderr=${stderr}`)), 15000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程服务提前退出 code=${code}；stderr=${stderr}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/file.bin`,
    /** 把收到的请求读回来，用于断言「curl 到底发了什么」 */
    requests: async () => {
      try {
        return (await import("node:fs/promises")).readFile(handlers["/file.bin"]?.echoFile ?? configFile, "utf8");
      } catch {
        return stdout;
      }
    },
    temp,
    close: async () => {
      child.stdin.end();
      child.kill();
      await temp.cleanup();
    },
  };
}

/** 一个像样的 302 响应头块（Location 正是把早先的轮询逻辑带偏的那一行）。 */
const FOUND_BLOCK = [
  "HTTP/1.1 302 Found",
  "Content-Length: 0",
  "Location: http://127.0.0.1:1/real",
  "",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// 1. 跳转链：本仓踩过的最重要的一个坑
// ---------------------------------------------------------------------------

curlTest("跳转链（curl）：302 之后才回 206 时，绝不能把 302 当成最终响应", async () => {
  // 回归用例。curl 的 --dump-header 文件是「先写 302 那一块、再追加最终响应」，
  // 早先的轮询逻辑把 302 当最终响应，误判成「不支持分段」还顺手把 curl 杀了。
  // 所以这里除了断言最终状态码，还要专门断言 status !== 302。
  const start = 1024;
  const end = start + 64 * 1024 - 1;
  const size = 256 * 1024;
  const server = await spawnRangeServer(size, {
    "/file.bin": { kind: "redirect", status: 302, location: "/real" },
    "/real": { kind: "range" },
  });
  try {
    const stream = await openRange(server.url, { transport: "curl", start, end, timeoutSec: 10 });
    assert.notEqual(stream.status, 302, "302 只是中间跳转，不该作为最终响应交出去");
    assert.equal(stream.status, 206);
    assert.equal(stream.total, size, "total 必须来自最终响应的 Content-Range");
    assert.equal(stream.transport, "curl");

    const result = await drain(stream);
    assert.equal(result.received, end - start + 1, "拿到的字节数必须恰好等于请求区间");
    assert.deepEqual(result.bytes, makeBody(size).subarray(start, end + 1));
    assert.equal(result.finished.status, "fulfilled", `整段读完后 finished 必须成功：${describeFinish(result.finished)}`);
    stream.abort();
  } finally {
    await server.close();
  }
});

test("跳转链（node）：手工跟随 302 之后同样要成功", async () => {
  const start = 4096;
  const end = start + 32 * 1024 - 1;
  const size = 256 * 1024;
  const body = makeBody(size);
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(302, { location: "/real", "content-length": "0" });
      res.end();
    },
    "/real": rangeHandler(body),
  });
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start, end, timeoutSec: 10 });
    assert.notEqual(stream.status, 302, "node 侧是手动跟随跳转，不该把 302 交出去");
    assert.equal(stream.status, 206);
    assert.equal(stream.total, size);

    const bytes = await collect(stream);
    assert.equal(bytes.length, end - start + 1);
    assert.deepEqual(bytes, body.subarray(start, end + 1));
  } finally {
    await server.close();
  }
});

test("跳转链的原始 dump 形态（302 块 + 206 块）能被读侧正确解读", async () => {
  // 上面两条是端到端的，这条把「curl 到底写了什么」直接钉住：
  // 只要读侧取的是最后一块且认得出 206，跳转链就不会被误判成「不支持分段」。
  const temp = await makeTempDir();
  try {
    const file = await dumpHeaderFile(
      temp,
      "redirect-chain.hdr",
      [
        FOUND_BLOCK,
        "HTTP/1.1 206 Partial Content",
        "Content-Range: bytes 1024-66559/262144",
        "Content-Length: 65536",
        "Accept-Ranges: bytes",
        "",
        "",
      ].join("\n"),
    );
    const blocks = parseHeaderFile(file);
    assert.equal(blocks.length, 2, "302 与 206 各占一块");
    assert.equal(blocks[0].status, 302, "中间跳转块的状态码要认得出来（它必须被判为「未定稿」而继续轮询）");
    const last = blocks[blocks.length - 1];
    assert.equal(last.status, 206);
    assert.deepEqual(
      parseContentRange(last.headers["content-range"]),
      { start: 1024, end: 66559, total: 262144 },
      "取最后一块才能拿到真正的总大小",
    );
  } finally {
    await temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. 416：请求区间超出资源
// ---------------------------------------------------------------------------

test("416（node）：区间超出资源时抛 SourceError，而不是静默交出错数据", async () => {
  // 这是「分片边界算错」的兜底：宁可整段失败让引擎重试，也不能把短读当成功。
  const server = await startServer({ size: 64 * 1024 });
  try {
    await assert.rejects(
      () => openRange(server.url, { transport: "node", start: 0, end: 1024 * 1024, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.match(error.message, /416/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

curlTest("416（curl）：同样抛 SourceError，而不是把 416 页面当数据收下", async () => {
  // 分片边界算错时最需要看到的证据就是「服务器说了 416」，所以这里不只断言抛错，
  // 还要求错误消息真的带上 416 —— 否则排障时只能看到一句「下载失败」，无从下手。
  const server = await spawnRangeServer(64 * 1024, { "/file.bin": { kind: "range" } });
  try {
    await assert.rejects(
      () => openRange(server.url, { transport: "curl", start: 0, end: 1024 * 1024, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.match(error.message, /416/, `错误消息里要能看到 416，实际是「${error.message}」`);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 服务端不支持 Range
// ---------------------------------------------------------------------------

test("不支持 Range（node）：默认抛 UnsupportedError，允许降级时返回 200 整包", async () => {
  const server = await startServer({ size: 128 * 1024, ignoreRange: true });
  try {
    await assert.rejects(
      () => openRange(server.url, { transport: "node", start: 0, end: 1024, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof UnsupportedError, `期望 UnsupportedError，实际 ${error?.name}`);
        return true;
      },
    );

    const stream = await openRange(server.url, {
      transport: "node",
      start: 0,
      end: server.body.length - 1,
      allowFullResponse: true,
      timeoutSec: 10,
    });
    assert.equal(stream.status, 200, "允许降级时 200 是合法结论");
    assert.equal(stream.total, server.body.length, "200 没有 Content-Range，大小只能取 content-length");
    assert.deepEqual(await collect(stream), server.body);
  } finally {
    await server.close();
  }
});

curlTest("不支持 Range（curl）：默认抛 UnsupportedError，不允许静默降级", async () => {
  const server = await spawnRangeServer(128 * 1024, { "/file.bin": { kind: "norange" } });
  try {
    await assert.rejects(
      () => openRange(server.url, { transport: "curl", start: 0, end: 1024, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof UnsupportedError, `期望 UnsupportedError，实际 ${error?.name}: ${error?.message}`);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

curlTest("不支持 Range（curl）：允许降级时返回 200 整包，大小取 content-length", async () => {
  const size = 128 * 1024;
  const server = await spawnRangeServer(size, { "/file.bin": { kind: "norange" } });
  try {
    const stream = await openRange(server.url, {
      transport: "curl",
      start: 0,
      end: size - 1,
      allowFullResponse: true,
      timeoutSec: 10,
    });
    assert.equal(stream.status, 200, "服务器给了整包，状态码就该是 200");
    assert.equal(stream.total, size, "200 没有 Content-Range，大小只能取 content-length");

    const result = await drain(stream);
    assert.equal(
      result.received,
      size,
      `整包必须一个字节都不少：${describeBytesDiff(result.bytes, makeBody(size))}`,
    );
    assert.equal(result.finished.status, "fulfilled", `整包读完 finished 必须成功：${describeFinish(result.finished)}`);
    assert.deepEqual(result.bytes, makeBody(size));
    stream.abort();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 服务端撒谎：206 但 Content-Range 对不上
// ---------------------------------------------------------------------------

test("服务端撒谎（node）：Content-Range 与请求不符时抛 SourceError，且消息里期望值与实际值都在", async () => {
  const size = 1024 * 1024;
  const body = makeBody(size);
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(206, {
        "content-range": `bytes 0-511/${body.length}`,
        "content-length": "512",
        "accept-ranges": "bytes",
      });
      res.end(body.subarray(0, 512));
    },
  });
  try {
    await assert.rejects(
      () => openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: size - 1, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.match(error.message, /期望 0-1048575/, "错误消息里要能看到期望区间，否则排障时无从下手");
        assert.match(error.message, /实际 bytes 0-511\/1048576/, "也要能看到服务端实际给了什么");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

curlTest("服务端撒谎（curl）：同样抛 SourceError，且消息里期望值与实际值都在", async () => {
  const size = 1024 * 1024;
  const server = await spawnRangeServer(size, { "/file.bin": { kind: "lying" } });
  try {
    await assert.rejects(
      () => openRange(server.url, { transport: "curl", start: 0, end: size - 1, timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.match(error.message, /期望 0-1048575/, "错误消息里要能看到期望区间，否则排障时无从下手");
        assert.match(error.message, /实际 bytes 0-511\/1048576/, "也要能看到服务端实际给了什么");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. probe()
// ---------------------------------------------------------------------------

test("probe（node）：HEAD 自称 accept-ranges: bytes 时必须再用 Range: bytes=0-0 复核一次", async () => {
  // 声明不等于事实：实测存在「HEAD 说支持分段、Range GET 却回 200 整包」的服务端。
  // 信了声明就会规划出多分段，然后每一段都在第一字节上失败，所以必须真发一次 Range 请求。
  const server = await startServer({ size: 96 * 1024, etag: '"probe-v1"' });
  try {
    const info = await probe(server.url, { transport: "node", timeoutSec: 10 });
    assert.equal(info.size, server.body.length);
    assert.equal(info.acceptRanges, true);
    assert.equal(info.etag, '"probe-v1"');
    assert.equal(info.transport, "node");
    assert.equal(info.finalUrl, server.url);
    assert.equal(info.filename, "file.bin", "没有 Content-Disposition 时退化到 URL 末段");
    assert.equal(server.state.requests, 2, "HEAD 之后必须再发一次 Range 请求复核");
    assert.deepEqual(server.state.ranges, [[0, 0]], "复核用的正是 Range: bytes=0-0");
  } finally {
    await server.close();
  }
});

test("probe（node）：HEAD 自称支持分段、Range GET 却回 200 整包时 acceptRanges 必须是 false", async () => {
  const body = makeBody(2048);
  const server = await customServer({
    "/file.bin": (req, res) => {
      // 嘴上说支持分段，其实完全不理会 Range
      res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
    },
  });
  try {
    const info = await probe(`${server.base}/file.bin`, { transport: "node", timeoutSec: 10 });
    assert.equal(info.acceptRanges, false, "真去取 0-0 拿到的是 200，就不能当成支持分段");
    assert.equal(info.size, body.length, "拿不到 206 时 size 只能退回 content-length");
  } finally {
    await server.close();
  }
});

test("probe（node）：HEAD 不被支持（405）时退回 Range: bytes=0-0 的 GET", async () => {
  const body = makeBody(7777);
  const server = await recordServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(405, { "content-length": "0" });
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : body.length - 1;
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    });
    res.end(body.subarray(start, end + 1));
  });
  try {
    const info = await probe(`${server.base}/file.bin`, { transport: "node", timeoutSec: 10 });
    assert.equal(info.acceptRanges, true);
    assert.equal(info.size, body.length, "size 优先用复核请求的 Content-Range 总量");
    assert.equal(server.received.length, 2, "一次 HEAD（失败）+ 一次带 Range 的 GET");
    assert.equal(server.received[1].headers.range, "bytes=0-0", "兜底的探测请求必须真的带 Range");
  } finally {
    await server.close();
  }
});

test("probe（node）：调用方传了 headers 时，复核请求仍必须带 Range: bytes=0-0", async () => {
  // 复核请求的构造是 `{ ...options, method: "GET", headers: { ...headers, range } }`：
  // 一旦 `...options` 落在后面，调用方的 `options.headers` 会把 `range` 整个吃掉，
  // 复核 GET 退化成「取整包」被服务端按 200 回，真支持分段的来源就被判成不支持
  // （`acceptRanges: false`），而且这个错误还会顺带丢掉 Content-Range 里的总大小。
  const body = makeBody(4096);
  const server = await recordServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (!match) {
      res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    });
    res.end(body.subarray(start, end + 1));
  });
  try {
    const info = await probe(`${server.base}/file.bin`, {
      transport: "node",
      headers: { authorization: "Bearer SECRET", cookie: "sid=1" },
      timeoutSec: 10,
    });
    assert.equal(server.received.length, 2, "一次 HEAD + 一次复核 GET");
    assert.equal(
      server.received[1].headers.range,
      "bytes=0-0",
      "调用方的 headers 不能把复核请求的 Range 头覆盖掉（否则复核退化成取整包）",
    );
    assert.equal(info.acceptRanges, true, "复核请求真的回了 206 才能判定支持分段");
    assert.equal(info.size, body.length, "size 应取复核响应的 Content-Range 总量");
  } finally {
    await server.close();
  }
});

curlTest("probe（curl）：同样能拿到大小、Accept-Ranges、ETag", async () => {
  const size = 96 * 1024;
  const server = await spawnRangeServer(size, {
    "/file.bin": { kind: "head", headers: { etag: '"probe-v1"', "content-type": "application/octet-stream" } },
  });
  try {
    const info = await probe(server.url, { transport: "curl", timeoutSec: 10 });
    assert.equal(info.size, size);
    assert.equal(info.acceptRanges, true);
    assert.equal(info.etag, '"probe-v1"');
    assert.equal(info.transport, "curl");
  } finally {
    await server.close();
  }
});

curlTest("probe（curl）：服务端给了 filename* 时以它为准", async () => {
  const size = 4096;
  const server = await spawnRangeServer(size, {
    "/file.bin": {
      kind: "head",
      headers: {
        "content-disposition": "attachment; filename=\"ascii.zip\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip",
      },
    },
  });
  try {
    const info = await probe(server.url, { transport: "curl", timeoutSec: 10 });
    assert.equal(info.filename, "中文.zip", "RFC 5987 的 filename* 才是服务端想给的名字");
    assert.equal(info.size, size);
  } finally {
    await server.close();
  }
});

test("probe：filename* 优先于 filename，坏百分号序列退回到 filename", () => {
  // RFC 5987 的 filename* 才是「服务端想给的名字」，filename 只是给老客户端的 ASCII 兜底；
  // 两者同时出现时必须听 filename*，否则中文名会被下成乱码或问号。
  const extended = "attachment; filename=\"ascii.zip\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip";
  assert.equal(filenameFromHeaders({ "content-disposition": extended }, "http://127.0.0.1/f.bin"), "中文.zip");

  const broken = "attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E4%B8%AD%ZZ.zip";
  assert.equal(
    filenameFromHeaders({ "content-disposition": broken }, "http://127.0.0.1/f.bin"),
    "fallback.zip",
    "filename* 解不开时不能把整个文件名丢掉",
  );
});

test("probe：Content-Disposition 缺失时文件名退化到 URL 末段并解码", () => {
  assert.equal(filenameFromHeaders({}, "http://127.0.0.1/%E4%B8%AD%E6%96%87%20file.zip"), "中文 file.zip");
  assert.equal(
    filenameFromHeaders({ "content-disposition": "attachment" }, "http://127.0.0.1/path/to/file.tar.gz"),
    "file.tar.gz",
  );
});

// ---------------------------------------------------------------------------
// 6. 响应头解析的单元测试
// ---------------------------------------------------------------------------

test("parseContentRange：正常、通配 total、以及各种非区间的形态", () => {
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.deepEqual(parseContentRange("Bytes 100-199/*"), { start: 100, end: 199, total: null });
  assert.equal(parseContentRange(undefined), null);
  assert.equal(parseContentRange(""), null);
  assert.equal(parseContentRange("bytes */1000"), null, "416 用的 `bytes */N` 不是一段有效区间");
  assert.equal(parseContentRange("items 0-99/1000"), null);
  assert.equal(parseContentRange("bytes 0-/1000"), null);
});

test("parseHeaderFile：只写了一半的响应头绝不能被当成有效的 206", async () => {
  // curl 是流式往文件里追加的，轮询随时可能读到中间态：
  // 「状态行已落盘、离 Content-Range 还差几行」时若被当成定稿，就会拿不到 total 而误判。
  const temp = await makeTempDir();
  try {
    const truncated = await dumpHeaderFile(
      temp,
      "truncated.hdr",
      ["HTTP/1.1 206 Partial Content", "Content-Length: 1048576", "", ""].join("\n"),
    );
    const partial = parseHeaderFile(truncated);
    assert.equal(partial.length, 1, "状态行本身是认得出来的");
    assert.equal(partial[0].status, 206);
    assert.equal(
      parseContentRange(partial[0].headers["content-range"]),
      null,
      "没有 Content-Range 就解析不出区间——读侧据此判定「还没定稿」，必须继续轮询",
    );

    const statusOnly = await dumpHeaderFile(temp, "status-only.hdr", "HTTP/1.1 302 Found\n\n");
    const only = parseHeaderFile(statusOnly);
    assert.equal(only.length, 1);
    assert.equal(only[0].status, 302, "只有状态行的块仍要识别得出来，否则 302 中间态会被彻底忽略");

    const none = await dumpHeaderFile(temp, "empty.hdr", "");
    assert.deepEqual(parseHeaderFile(none), [], "空文件（curl 刚创建、还没写）要回空数组而不是抛错");
  } finally {
    await temp.cleanup();
  }
});

test("parseHeaderFile：末尾没写完的那一块必须丢掉（残块里的 Content-Range 可能是截断值）", async () => {
  // 真机踩过的坑：curl 正把 `Content-Range: bytes 0-9/100000` 写进文件，读侧抢在
  // 半行时读到的是 `/100`——若把残块当定稿，就会按 100 字节的资源去规划分片。
  // 所以判定标准是「这一块有没有以空行收尾」，而不是「有没有解析出字段」。
  const temp = await makeTempDir();
  try {
    const written = ["HTTP/1.1 206 Partial Content", "Content-Range: bytes 0-9/100000", "Content-Length: 10"];
    const inFlight = await dumpHeaderFile(
      temp,
      "in-flight.hdr",
      [FOUND_BLOCK, ...written].join("\n"), // 末尾没有空行：这是 curl 正写到一半的快照
    );
    const blocks = parseHeaderFile(inFlight);
    assert.equal(blocks.length, 1, "只有 302 那一块写完了，206 残块必须被丢掉");
    assert.equal(blocks[0].status, 302);
    assert.equal(
      blocks.some((block) => block.status === 206),
      false,
      "读到一半的 206 不能被当成定稿",
    );

    const complete = await dumpHeaderFile(temp, "complete.hdr", `${[FOUND_BLOCK, ...written].join("\n")}\n\n`);
    const settled = parseHeaderFile(complete);
    assert.equal(settled.length, 2, "curl 写完（补上收尾空行）之后两块都要在");
    assert.equal(settled[1].status, 206);
    assert.deepEqual(
      parseContentRange(settled[1].headers["content-range"]),
      { start: 0, end: 9, total: 100000 },
      "写完的块能解析出完整的总量，这正是残块不能信的对照",
    );
  } finally {
    await temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. 没有 curl 的环境 / --curl-path 语义
// ---------------------------------------------------------------------------

test("--curl-path 指向不存在的文件：跳过它继续找系统 curl，找不到才返回 null", () => {
  // 语义读自 src/transport.mjs 的 detectCurl()：preferred 只是候选表的**第一项**，
  // 不是「唯一项」——所以路径写错时会静默落到 PATH 上的 curl，而不是报错。
  // 这里把这个行为钉住（它是好是坏取决于调用方，但必须与代码一致）。
  const missing = "definitely-not-a-real-curl-binary";
  const found = detectCurl(missing);
  if (curl === null) {
    assert.equal(found, null, "整机都没有 curl 时结果只能是 null");
  } else {
    assert.ok(found, "系统 curl 可用时必须回退到它而不是返回 null");
    assert.notEqual(found?.path, missing, "不存在的首选路径不能被当成可用路径返回");
  }

  // 探测机制本身是有效的（对照）：有效路径必须被采纳
  assert.equal(detectCurl(curl?.path ?? missing)?.path ?? null, curl?.path ?? null);
});

test("完全找不到 curl 时：detectCurl 回 null，openRange/probe 明确抛 SourceError", async () => {
  // PATH 清空的子进程里跑，这样既不改本进程环境，也不依赖哪台机器装没装 curl。
  // 清空 PATH 之后 spawnSync 必然报 ENOENT，正是「无 curl 机器」的等价环境。
  const script = [
    'import { detectCurl, openRange, probe } from "./src/transport.mjs";',
    "const found = detectCurl();",
    'if (found !== null) { console.log(JSON.stringify({ ok: false, found })); process.exit(3); }',
    'let openKind = null;',
    'let openMessage = "";',
    'try { await openRange("http://127.0.0.1:1/file.bin", { transport: "curl", start: 0, end: 1, startupTimeoutMs: 500 }); }',
    "catch (error) { openKind = error.name; openMessage = error.message; }",
    "let probeKind = null;",
    'let probeMessage = "";',
    'try { await probe("http://127.0.0.1:1/file.bin", { transport: "curl", timeoutSec: 5 }); }',
    "catch (error) { probeKind = error.name; probeMessage = error.message; }",
    "console.log(JSON.stringify({ detect: found, openKind, openMessage, probeKind, probeMessage }));",
  ].join("\n");

  const raw = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      // PATH 指到一个不存在的目录：不动本进程环境，也不用去猜 PATH 在哪
      { env: { ...process.env, PATH: "ghpull-empty-path", Path: "ghpull-empty-path" }, timeout: 30000, encoding: "utf8" },
      (error, stdout, stderr) => (error && !stdout ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
    );
  });
  const result = JSON.parse(String(raw).trim().split("\n").pop() ?? "{}");

  assert.equal(result.detect, null, "约定：找不到 curl 必须回 null，不能猜一个路径出来");
  assert.equal(result.openKind, "SourceError");
  assert.match(result.openMessage, /curl/, "错误消息要说清是「没有 curl」，否则用户不知道该装什么");
  assert.equal(result.probeKind, "SourceError");
  assert.match(result.probeMessage, /curl/);
});

curlTest("curl 探测失败（服务端 5xx）时 probe 报 SourceError 并带上 curl 的 stderr", async () => {
  const server = await spawnRangeServer(1024, { "/file.bin": { kind: "static", status: 500 } });
  try {
    await assert.rejects(
      () => probe(server.url, { transport: "curl", timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.match(error.message, /curl|500/, "排障需要看到 curl 的退出码或 HTTP 状态");
        assert.doesNotMatch(error.message, /timed out|超时/, "5xx 必须被当成 5xx 报出来，不能靠等超时才发现");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("auto 传输在没有 curl 时不会因为「找不到 curl」而误报降级", async () => {
  // auto 只在遇到证书类错误时才去找 curl；普通 HTTP 必须老老实实走 node，
  // 否则离线机器上一条普通请求会被误导成「TLS 信任问题」。
  const server = await startServer({ size: 32 * 1024 });
  try {
    const stream = await openRange(server.url, {
      transport: "auto",
      start: 0,
      end: 1024,
      curlPath: "definitely-not-a-real-curl-binary",
      timeoutSec: 10,
    });
    assert.equal(stream.transport, "node");
    assert.equal(stream.status, 206);
    assert.equal((await collect(stream)).length, 1025);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 8. 字节数对账：声明的长度合法，但 body 与请求区间对不上
// ---------------------------------------------------------------------------

/** 造一个「声明的 Content-Range 与请求一致、实际只发 send 字节」的服务端。 */
function shortServer(body, send) {
  return customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(206, {
        "content-range": `bytes 0-9/${body.length}`,
        "content-length": String(send),
        "accept-ranges": "bytes",
      });
      res.end(body.subarray(0, send));
    },
  });
}

test("字节数对账（node）：206 声明 10 字节却只发 3 字节时 finished 必须 reject", async () => {
  // 协议层完全自洽（Content-Length 说 3，也只发了 3），只有「按请求区间数字节」
  // 才能发现少了：少发必须 reject，否则调用方会把半个分片当成下载完成。
  const body = makeBody(100);
  const server = await shortServer(body, 3);
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 });
    assert.equal(stream.status, 206);
    assert.equal(stream.total, 100, "total 取自 Content-Range");

    const result = await drain(stream);
    assert.equal(result.received, 3, "实际只收到 3 字节");
    assert.equal(result.finished.status, "rejected", "少发字节绝不能被当成正常完成");
    assert.ok(result.finished.reason instanceof SourceError, `期望 SourceError，实际 ${result.finished.reason?.name}`);
    assert.match(String(result.finished.reason.message), /响应体字节数与请求不符/);
    assert.match(String(result.finished.reason.message), /收到 3 字节/);
    assert.match(String(result.finished.reason.message), /应为 10 字节/);
  } finally {
    await server.close();
  }
});

test("字节数对账（node）：206 声明 10 字节却发了 20 字节时 finished 必须 reject", async () => {
  // 多发同样要 reject：多出来的字节说明服务端给的区间根本不是我们要的那段，
  // 拿它去拼装就是把别人的数据写进文件，属于静默损坏。
  const body = makeBody(100);
  const server = await shortServer(body, 20);
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 });
    const result = await drain(stream);
    assert.equal(result.received, 20, "实际收到 20 字节");
    assert.equal(result.finished.status, "rejected", "多发字节绝不能被当成正常完成");
    assert.ok(result.finished.reason instanceof SourceError, `期望 SourceError，实际 ${result.finished.reason?.name}`);
    assert.match(String(result.finished.reason.message), /响应体字节数与请求不符/);
    assert.match(String(result.finished.reason.message), /收到 20 字节/);
    assert.match(String(result.finished.reason.message), /应为 10 字节/);
  } finally {
    await server.close();
  }
});

test("字节数对账（node）：body 发到一半连接被掐断时 finished 必须 reject", async () => {
  // 真实网络里最常见的形态：响应头完全正常，body 走到一半对端没了。
  const body = makeBody(100);
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(206, {
        "content-range": `bytes 0-9/${body.length}`,
        "content-length": "10",
        "accept-ranges": "bytes",
      });
      res.write(body.subarray(0, 4));
      setTimeout(() => res.socket?.destroy(), 30);
    },
  });
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 });
    const result = await drain(stream);
    assert.equal(result.received, 4, "掐断前只到了 4 字节");
    assert.equal(result.finished.status, "rejected", "半截 body 绝不能报成功");
    assert.ok(result.finished.reason instanceof Error);
  } finally {
    await server.close();
  }
});

test("字节数对账（node）：正好收满请求区间时 finished 必须 resolve", async () => {
  // 正向对照：上面三条都 reject，但「刚好 10 字节」必须成功——否则就是宁可误报也不放过。
  const body = makeBody(100);
  const server = await shortServer(body, 10);
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 });
    const result = await drain(stream);
    assert.equal(result.received, 10);
    assert.equal(result.finished.status, "fulfilled", `刚好收满时必须成功：${describeFinish(result.finished)}`);
    assert.equal(result.readError, null, "正常收尾不该从迭代器抛错");
  } finally {
    await server.close();
  }
});

test("取消（node）：abort() 之后 finished 必须以「已取消」reject，而不是报成功", async () => {
  // 旧实现把 res.destroy() 之后的 close 当成正常结束 resolve 出去，于是迭代器抛
  // ERR_STREAM_PREMATURE_CLOSE、finished 却报成功——只 await finished 的调用方会把
  // 半个分片标记成完成。取消必须是一个明确的失败信号。
  const body = makeBody(100);
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(206, {
        "content-range": `bytes 0-9/${body.length}`,
        "content-length": "10",
        "accept-ranges": "bytes",
      });
      res.write(body.subarray(0, 4)); // 之后既不发也不结束：把连接挂在半开状态
    },
  });
  try {
    const stream = await openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 });
    stream.abort();

    const result = await drain(stream);
    assert.equal(result.finished.status, "rejected", "取消必须 reject，绝不能报成功");
    assert.ok(result.finished.reason instanceof GhpullError, `期望 GhpullError，实际 ${result.finished.reason?.name}`);
    assert.match(String(result.finished.reason.message), /已取消/);
  } finally {
    await server.close();
  }
});

test("取消（node）：传入的 signal 触发时同样以「已取消」reject", async () => {
  const body = makeBody(100);
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(206, {
        "content-range": `bytes 0-9/${body.length}`,
        "content-length": "10",
        "accept-ranges": "bytes",
      });
      res.write(body.subarray(0, 4));
    },
  });
  const controller = new AbortController();
  try {
    const stream = await openRange(`${server.base}/file.bin`, {
      transport: "node",
      start: 0,
      end: 9,
      signal: controller.signal,
      timeoutSec: 10,
    });
    controller.abort();

    const result = await drain(stream);
    assert.equal(result.finished.status, "rejected", "signal 触发后 finished 必须 reject");
    assert.ok(result.finished.reason instanceof GhpullError, `期望 GhpullError，实际 ${result.finished.reason?.name}`);
    assert.match(String(result.finished.reason.message), /已取消/);
  } finally {
    controller.abort();
    await server.close();
  }
});

curlTest("字节数对账（curl）：206 声明 10 字节却只发 3 字节时 finished 必须 reject", async () => {
  const size = 100;
  const server = await spawnRangeServer(size, { "/file.bin": { kind: "short", sendBytes: 3 } });
  try {
    const stream = await openRange(server.url, { transport: "curl", start: 0, end: 9, timeoutSec: 10 });
    assert.equal(stream.status, 206);
    assert.equal(stream.total, size);

    const result = await drain(stream);
    assert.equal(result.received, 3);
    assert.equal(result.finished.status, "rejected", "curl 侧同样不能把少发当成功");
    assert.match(String(result.finished.reason?.message), /响应体字节数与请求不符/);
    assert.match(String(result.finished.reason?.message), /收到 3 字节/);
    assert.match(String(result.finished.reason?.message), /应为 10 字节/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 9. 错误如实上报 + 监听器不泄漏
// ---------------------------------------------------------------------------

for (const status of [403, 404, 429, 500]) {
  test(`错误如实上报（node）：Range 请求收到 HTTP ${status} 时抛 SourceError 并带上真实状态码`, async () => {
    // `>= 400` 是「这个来源这次失败了」，不是「它不支持分段」。旧实现一律报
    // UnsupportedError，把 404 说成「该来源不支持分段下载」，既误导用户也误导上层的
    // 来源淘汰逻辑——排障时必须能一眼看到真实状态码。
    const server = await customServer({
      "/file.bin": (_req, res) => {
        res.writeHead(status, { "content-length": "0" });
        res.end();
      },
    });
    try {
      await assert.rejects(
        () => openRange(`${server.base}/file.bin`, { transport: "node", start: 0, end: 9, timeoutSec: 10 }),
        (error) => {
          assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
          assert.ok(!(error instanceof UnsupportedError), "4xx/5xx 不是「不支持分段」，不能报 UnsupportedError");
          assert.match(error.message, new RegExp(String(status)), "错误消息里必须有真实状态码");
          assert.doesNotMatch(error.message, /不支持分段下载/, "不能把 4xx/5xx 说成「该来源不支持分段下载」");
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });
}

test("错误如实上报（node）：probe 打 404 时同样抛 SourceError 并带上 404", async () => {
  const server = await customServer({
    "/file.bin": (_req, res) => {
      res.writeHead(404, { "content-length": "0" });
      res.end();
    },
  });
  try {
    await assert.rejects(
      () => probe(`${server.base}/file.bin`, { transport: "node", timeoutSec: 10 }),
      (error) => {
        assert.ok(error instanceof SourceError, `期望 SourceError，实际 ${error?.name}`);
        assert.ok(!(error instanceof UnsupportedError), "probe 的 404 也不是「不支持分段」");
        assert.match(error.message, /404/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("监听器不泄漏（node）：同一条 signal 上连续失败 5 次后不留 abort 监听器", async () => {
  // 每条请求都要往 signal 上挂一个 abort 监听器来及时掐断连接；失败路径若不摘掉，
  // 一次「重试 10 个镜像」的下载就会在同一根 signal 上挂满监听器（还会钉住 socket）。
  const controller = new AbortController();
  const dead = "http://127.0.0.1:1/file.bin"; // 关闭的端口：连接必然被拒
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() =>
      openRange(dead, { transport: "node", start: 0, end: 9, timeoutSec: 5, signal: controller.signal }),
    );
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "失败路径必须摘掉自己的 abort 监听器");
});

test("监听器不泄漏（node）：成功请求读完之后同样不留 abort 监听器", async () => {
  const server = await startServer({ size: 4096 });
  const controller = new AbortController();
  try {
    const stream = await openRange(server.url, {
      transport: "node",
      start: 0,
      end: 1023,
      signal: controller.signal,
      timeoutSec: 10,
    });
    assert.equal((await collect(stream)).length, 1024);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "成功路径也要摘干净");
  } finally {
    await server.close();
  }
});

curlTest("监听器不泄漏（curl）：同一条 signal 上连续失败 4 次后不留 abort 监听器", async () => {
  const controller = new AbortController();
  const dead = "http://127.0.0.1:1/file.bin"; // 关闭的端口：curl 退出码 7
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(() =>
      openRange(dead, {
        transport: "curl",
        start: 0,
        end: 9,
        timeoutSec: 5,
        startupTimeoutMs: 5000,
        signal: controller.signal,
      }),
    );
  }
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "curl 侧的头部阶段 throw 路径必须摘掉 abort 监听器（旧实现会泄漏到刷 MaxListenersExceededWarning）",
  );
});

// ---------------------------------------------------------------------------
// 10. 跨 origin 跳转：凭据不能跟着跑
// ---------------------------------------------------------------------------

test("跨 origin 跳转（node）：新 origin 收不到 authorization / cookie，同 origin 继续带", async () => {
  // 凭据跟着跳转跑到别的站点是真事故：A 站把请求 302 到 B 站，Authorization 头
  // 一旦跟过去，等于把用户的令牌交给第三方。判定标准是「协议 + 主机 + 端口」。
  const body = makeBody(64);
  const target = await recordServer(rangeHandler(body));
  const crossOrigin = await recordServer((_req, res) => {
    res.writeHead(302, { location: `${target.base}/real.bin`, "content-length": "0" });
    res.end();
  });
  const sameOrigin = await recordServer((req, res) => {
    if ((req.url ?? "").startsWith("/real.bin")) {
      rangeHandler(body)(req, res);
      return;
    }
    res.writeHead(302, { location: "/real.bin", "content-length": "0" });
    res.end();
  });
  try {
    const credentials = { authorization: "Bearer SECRET", cookie: "sid=1" };

    const crossed = await openRange(`${crossOrigin.base}/file.bin`, {
      transport: "node",
      start: 0,
      end: 9,
      headers: credentials,
      timeoutSec: 10,
    });
    const crossedResult = await drain(crossed);
    assert.equal(crossedResult.received, 10, "跳转之后仍要正常拿到请求区间");
    assert.equal(crossedResult.finished.status, "fulfilled", describeFinish(crossedResult.finished));

    assert.equal(crossOrigin.received.length, 1, "第一跳只该访问原 origin 一次");
    assert.equal(crossOrigin.received[0].headers.authorization, "Bearer SECRET", "原 origin 当然要带凭据");
    assert.equal(crossOrigin.received[0].headers.cookie, "sid=1");

    assert.equal(target.received.length, 1, "跳转后只该访问新 origin 一次");
    const hopped = target.received[0];
    assert.equal(hopped.headers.authorization, undefined, "换了 origin 就不能再带 authorization");
    assert.equal(hopped.headers.cookie, undefined, "换了 origin 就不能再带 cookie");
    assert.equal(hopped.headers.range, "bytes=0-9", "非凭据头要照旧带上：跳转不该把整个请求头丢掉");
    assert.equal(hopped.headers["accept-encoding"], "identity", "传输层自带的头也要在");

    const sameOriginStream = await openRange(`${sameOrigin.base}/file.bin`, {
      transport: "node",
      start: 0,
      end: 9,
      headers: credentials,
      timeoutSec: 10,
    });
    const sameResult = await drain(sameOriginStream);
    assert.equal(sameResult.received, 10);
    assert.equal(sameResult.finished.status, "fulfilled", describeFinish(sameResult.finished));

    assert.equal(sameOrigin.received.length, 2, "同 origin 跳转是两次请求");
    assert.equal(sameOrigin.received[0].headers.authorization, "Bearer SECRET");
    assert.equal(
      sameOrigin.received[1].headers.authorization,
      "Bearer SECRET",
      "同 origin 的跳转必须继续带凭据（否则登录态下载会莫名其妙 401）",
    );
    assert.equal(sameOrigin.received[1].headers.cookie, "sid=1");
  } finally {
    await crossOrigin.close();
    await target.close();
    await sameOrigin.close();
  }
});

test("跨 origin 跳转（probe 路径）：跳转后的每一次请求都不能带凭据", async () => {
  // probe 走的是同一条 requestOnce，但它自己会额外发一次复核请求，
  // 所以「有没有哪个角落漏了剥离」必须由记录服务端来回答。
  const body = makeBody(32);
  const target = await recordServer((req, res) => {
    res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  const front = await recordServer((_req, res) => {
    res.writeHead(302, { location: `${target.base}/real.bin`, "content-length": "0" });
    res.end();
  });
  try {
    await probe(`${front.base}/file.bin`, {
      transport: "node",
      headers: { authorization: "Bearer SECRET", cookie: "sid=1" },
      timeoutSec: 10,
    });

    assert.ok(front.received.length >= 1, "前置服务必须收到请求");
    assert.equal(front.received[0].headers.authorization, "Bearer SECRET", "原 origin 要带凭据");
    assert.equal(front.received[0].headers.cookie, "sid=1");

    assert.ok(target.received.length >= 1, "跳转后的服务必须收到请求");
    for (const request of target.received) {
      assert.equal(request.headers.authorization, undefined, `${request.path} 上的 ${request.method} 不能带 authorization`);
      assert.equal(request.headers.cookie, undefined, `${request.path} 上的 ${request.method} 不能带 cookie`);
    }
  } finally {
    await front.close();
    await target.close();
  }
});
