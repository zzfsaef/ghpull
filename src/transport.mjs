// SPDX-License-Identifier: MIT
/**
 * 传输层：把「一次 HTTP Range 请求」抽象成可中断的字节流。
 *
 * 两个实现：
 *   - `node`：内置 `node:http`/`node:https`，零外部依赖，默认。
 *   - `curl`：调用系统 `curl`，用于 Node 自带 CA 不被信任的环境（企业代理、
 *     自签中间人）——那种环境里 Node 会报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，
 *     而 curl 走系统证书库正常工作。
 * `auto`（默认）先用 node，遇到 TLS 证书类错误时自动改用 curl。
 *
 * 两条纪律：
 *   1. 永远显式 `Accept-Encoding: identity`，避免服务端压缩把字节偏移搞乱。
 *   2. 收到 206 必须校验 `Content-Range` 与请求区间一致，不信服务端的自觉。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";

import { GhpullError, SourceError, UnsupportedError } from "./errors.mjs";
import { USER_AGENT } from "./version.mjs";

/** 允许的 `--transport` 取值。 */
export const TRANSPORTS = Object.freeze(["auto", "node", "curl"]);

const MAX_REDIRECTS = 5;
/**
 * curl 退出后还愿意等 dump-header 落盘的宽限（毫秒）。
 *
 * 头部阶段的轮询每 20ms 一次，而 curl 的 `--dump-header` 写盘发生在进程退出时：
 * 本地服务响应极快时 curl 会赶在轮询之前结束，此时 dump 文件里其实已经有完整
 * 响应头了，只是我们读早了。给一小段宽限重读，避免把「成功但太快」误判成
 * 「还没返回响应头就退出了」。
 */
const EXIT_GRACE_MS = 250;
let curlCounter = 0;
/** @type {Map<string, http.Agent|https.Agent>} */
const agentCache = new Map();

/**
 * 取（并缓存）一个 keepAlive agent。
 *
 * 为什么不靠默认 agent：Node 的 `https.globalAgent.maxSockets` 是 `Infinity`，
 * 并发上限就完全交给了调用方；这里显式设成我们自己的上限。
 * @param {string} protocol
 * @param {number} maxSockets
 */
function agentFor(protocol, maxSockets) {
  const key = `${protocol}:${maxSockets}`;
  const cached = agentCache.get(key);
  if (cached) return cached;
  const options = { keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, 8) };
  const agent = protocol === "http:" ? new http.Agent(options) : new https.Agent(options);
  agentCache.set(key, agent);
  return agent;
}

/** 关闭所有缓存的 agent（进程退出前调用，避免 keepAlive 连接吊住事件循环）。 */
export function closeAgents() {
  for (const agent of agentCache.values()) agent.destroy();
  agentCache.clear();
}

/**
 * 探测系统 curl。返回可用路径或 null。
 * @param {string} [preferred] 用户显式指定的路径（`--curl-path`）
 * @returns {{path: string, version: string}|null}
 */
export function detectCurl(preferred) {
  /** @type {string[]} */
  const candidates = [];
  if (preferred) candidates.push(preferred);
  const fromEnv = process.env.GHPULL_CURL;
  if (fromEnv) candidates.push(fromEnv);
  if (process.platform === "win32") candidates.push("curl.exe", "curl");
  else candidates.push("curl");
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (probe.status === 0 && probe.stdout) {
      const first = probe.stdout.split("\n")[0].trim();
      return { path: candidate, version: first };
    }
  }
  return null;
}

/**
 * 判断一个错误是不是「Node 不信任对端证书」这一类。
 * @param {unknown} error
 */
export function isCertificateError(error) {
  const code = /** @type {any} */ (error)?.code;
  const message = String(/** @type {any} */ (error)?.message ?? "");
  return (
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    /self[- ]signed certificate|unable to verify the first certificate/i.test(message)
  );
}

/** 构造请求头。 */
function baseHeaders(extra) {
  return {
    "user-agent": USER_AGENT,
    "accept-encoding": "identity",
    connection: "keep-alive",
    ...extra,
  };
}

/** 跨 origin 跳转时必须丢掉的请求头：它们是给原站点的凭据，不能顺手交给第三方。 */
const CREDENTIAL_HEADERS = Object.freeze(["authorization", "cookie", "proxy-authorization"]);

/**
 * 去掉凭据类请求头（大小写不敏感）。
 * @param {Record<string,string>} headers
 */
function stripCredentials(headers) {
  /** @type {Record<string,string>} */
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.includes(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * 发一次请求，手动跟随重定向。
 *
 * 手动跟随的理由不只是「数跳数」：跨 origin 的重定向必须重新考虑凭据头。
 * GitHub 发布包就是 `github.com → objects.githubusercontent.com`，
 * 如果把调用方给的 `authorization`/`cookie` 原样带过去，token 就白送给了跳转目标。
 * @param {string} url
 * @param {{method: string, headers: Record<string,string>, timeoutSec: number, maxSockets: number, signal?: AbortSignal, maxRedirects?: number}} options
 * @returns {Promise<{res: http.IncomingMessage, finalUrl: string, cleanup: () => void}>}
 */
function requestOnce(url, options) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import("node:http").ClientRequest|null} */
    let req = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const onAbort = () => {
      req?.destroy(new GhpullError("已取消"));
      fail(new GhpullError("已取消"));
    };

    const go = (target, redirectsLeft, headers) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return fail(new SourceError(`URL 无法解析：${target}`));
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(new UnsupportedError(`只支持 http/https，收到的是 ${parsed.protocol}`));
      }
      const transport = parsed.protocol === "http:" ? http : https;
      req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: options.method,
          headers: { ...baseHeaders(headers), host: parsed.host },
          agent: agentFor(parsed.protocol, options.maxSockets),
          signal: options.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume(); // 丢弃重定向响应体，否则连接无法复用
            if (redirectsLeft <= 0) return fail(new SourceError(`重定向次数超过 ${maxRedirects} 次`));
            const next = new URL(res.headers.location, target);
            // 只有同 origin 才继续带凭据头（origin = 协议 + 主机 + 端口）
            const nextHeaders = next.origin === parsed.origin ? headers : stripCredentials(headers);
            return go(next.toString(), redirectsLeft - 1, nextHeaders);
          }
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          // 响应体会在别处被消费，也可能被直接丢弃（探测只读响应头就把流 destroy 掉）。
          // 先挂一个空监听：否则「服务端中途掐断 + 调用方已经不要这个流了」会变成未处理的
          // 'error' 事件，Node 直接把它抛成未捕获异常。真正的错误处理在 makeBody 里。
          res.on("error", () => {});
          resolve({
            res,
            finalUrl: target,
            cleanup: () => {
              res.destroy();
              req?.destroy();
            },
          });
        },
      );
      req.setTimeout(options.timeoutSec * 1000, () => {
        req?.destroy(new SourceError(`请求超时（${options.timeoutSec}s 无响应）`));
      });
      req.on("error", (error) => fail(error));
      req.end();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    go(url, maxRedirects, options.headers ?? {});
  });
}

/** 解析 `Content-Range: bytes 0-99/1000`。 */
export function parseContentRange(value) {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

/**
 * 从响应头推断文件名。
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {string} url
 */
export function filenameFromHeaders(headers, url) {
  const disposition = headers["content-disposition"];
  const raw = Array.isArray(disposition) ? disposition[0] : disposition;
  if (raw) {
    const extended = /filename\*\s*=\s*([^;]+)/i.exec(raw);
    if (extended) {
      const value = extended[1].trim().replace(/^["']|["']$/g, "");
      const parts = value.split("''");
      const encoded = parts.length > 1 ? parts[1] : value;
      try {
        return decodeURIComponent(encoded);
      } catch {
        /* 落到下面继续尝试 */
      }
    }
    const plain = /filename\s*=\s*("([^"]*)"|([^;]*))/i.exec(raw);
    if (plain) {
      const value = (plain[2] ?? plain[3] ?? "").trim();
      if (value) return value;
    }
  }
  try {
    const base = path.posix.basename(new URL(url).pathname);
    if (base) return decodeURIComponent(base);
  } catch {
    /* 忽略 */
  }
  return "download.bin";
}

/**
 * 把任意字符串变成安全的文件名。
 * @param {string} name
 */
export function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "download.bin";
}

/**
 * 探测目标：大小、是否支持 Range、最终 URL、文件名。
 * @param {string} url
 * @param {{transport?: string, timeoutSec?: number, maxSockets?: number, curlPath?: string, headers?: Record<string,string>, signal?: AbortSignal}} [options]
 * @returns {Promise<{url: string, finalUrl: string, size: number|null, acceptRanges: boolean, filename: string, contentType: string|null, etag: string|null, lastModified: string|null, transport: string}>}
 */
export async function probe(url, options = {}) {
  const transport = options.transport ?? "auto";
  const timeoutSec = options.timeoutSec ?? 30;
  const maxSockets = options.maxSockets ?? 16;

  const attempt = async (/** @type {string} */ which) =>
    which === "curl"
      ? probeWithCurl(url, { ...options, timeoutSec })
      : probeWithNode(url, { ...options, timeoutSec, maxSockets });

  if (transport === "node" || transport === "curl") return attempt(transport);
  try {
    return await attempt("node");
  } catch (error) {
    if (!isCertificateError(error)) throw error;
    const curl = detectCurl(options.curlPath);
    if (!curl) {
      throw new GhpullError(
        `Node 不信任该站点的 TLS 证书（${/** @type {any} */ (error)?.code ?? "证书错误"}），` +
          `且没有找到可用的 curl 来改用系统证书库。可尝试设置 NODE_EXTRA_CA_CERTS，或安装 curl 后重试。`,
        { cause: error },
      );
    }
    return probeWithCurl(url, { ...options, timeoutSec });
  }
}

/**
 * node 实现：先 HEAD，不行再 `Range: bytes=0-0` 的 GET。
 *
 * HEAD 自称 `accept-ranges: bytes` 时也要用真正的 Range 请求复核一次：那是声明不是事实，
 * 实测存在「HEAD 说支持、Range GET 却回 200 整包」的服务端；信了声明就会规划出多分段，
 * 然后每个分段都在第一字节上失败。顺手也补齐 200 源的大小（旧实现只在 206 时给 size，
 * 和 curl 探测的结果不一致）。
 */
async function probeWithNode(url, options) {
  const headers = baseHeaders(options.headers);
  /** @type {Record<string,string|string[]|undefined>|null} */
  let responseHeaders = null;
  let finalUrl = url;
  let status = 0;

  try {
    const head = await requestOnce(url, { method: "HEAD", headers, ...options });
    responseHeaders = head.res.headers;
    status = head.res.statusCode ?? 0;
    finalUrl = head.finalUrl;
    head.cleanup();
  } catch {
    responseHeaders = null;
  }

  const headOk = responseHeaders !== null && status >= 200 && status < 300 && Boolean(responseHeaders["content-length"]);
  const headClaimsRanges =
    responseHeaders !== null && String(headerString(responseHeaders, "accept-ranges") ?? "").toLowerCase().includes("bytes");

  /** @type {Record<string,string|string[]|undefined>|null} */
  let rangedHeaders = null;
  let rangedStatus = 0;
  let rangedUrl = url;
  if (!headOk || headClaimsRanges) {
    // 这个复核 GET 是探测阶段唯一真去取字节的请求，也就可能被服务端在响应中途掐断
    // （真机上很常见）。重试几次再放弃：一次瞬时抖动不该被判成「该来源不支持分段」，
    // 那个误判的代价是整个下载退化成单流。真的一直失败，就把错误抛给调用方去换源。
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.signal?.aborted) throw new GhpullError("已取消");
      try {
        const ranged = await requestOnce(url, {
          // `...options` 必须放在 `headers` 之前：调用方传进来的 `options.headers`
          // 若整体覆盖 headers，我们请求的 `range: bytes=0-0` 就没了，复核 GET 退化成
          // 「取整包」并被服务端按 200 回，于是「支持分段」的来源被判成不支持。
          ...options,
          method: "GET",
          headers: { ...headers, range: "bytes=0-0" },
        });
        rangedHeaders = ranged.res.headers;
        rangedStatus = ranged.res.statusCode ?? 0;
        rangedUrl = ranged.finalUrl;
        ranged.res.destroy();
        ranged.cleanup();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }
    if (lastError !== null) throw lastError;
  }

  const effectiveHeaders = rangedHeaders ?? responseHeaders;
  if (effectiveHeaders === null) throw new SourceError(`无法获取 ${url} 的响应头`);
  const effectiveStatus = rangedHeaders ? rangedStatus : status;
  // HEAD 和 Range 请求都失败：这个来源就是不可用
  if (effectiveStatus >= 400 && !headOk) throw new SourceError(`${url} 返回 HTTP ${effectiveStatus}`);

  // 元数据优先取 HEAD 的（content-type/etag/last-modified 同样可靠，而且是整包信息）
  const meta = headOk ? /** @type {Record<string,string|string[]|undefined>} */ (responseHeaders) : effectiveHeaders;
  const contentRange = parseContentRange(headerString(effectiveHeaders, "content-range"));
  let size = null;
  let acceptRanges = false;
  if (effectiveStatus === 206 && contentRange?.total != null) {
    size = contentRange.total;
    acceptRanges = true;
  } else {
    // 拿不到 206 就不分段：哪怕响应头自称 `accept-ranges: bytes`
    size = declaredLength(meta);
  }

  return {
    url,
    finalUrl: rangedHeaders ? rangedUrl : finalUrl,
    size,
    acceptRanges,
    filename: sanitizeFilename(filenameFromHeaders(meta, rangedHeaders ? rangedUrl : finalUrl)),
    contentType: headerString(meta, "content-type"),
    etag: headerString(meta, "etag"),
    lastModified: headerString(meta, "last-modified"),
    transport: "node",
  };
}

/** 取单个响应头字符串。 */
function headerString(headers, name) {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : String(value);
}

/** 读 `content-length`：非数字/负数一律当「未知」。 */
function declaredLength(headers) {
  const value = Number(headerString(headers, "content-length"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * curl 实现：一次 `Range: bytes=0-0` 请求，把响应头 dump 到临时文件再解析。
 */
async function probeWithCurl(url, options) {
  const curl = detectCurl(options.curlPath);
  if (!curl) throw new SourceError("没有找到可用的 curl");
  const slot = headerSlot(options);
  try {
    const args = [
      "-sS",
      "-L",
      "--range",
      "0-0",
      "--dump-header",
      slot.name,
      "--output",
      process.platform === "win32" ? "NUL" : "/dev/null",
      // 响应体被 `--output` 导走了，stdout 空着，正好用来取「最终落到哪个 URL」——
      // `-L` 跟随跳转之后，dump 里最后一块的 `location` 指向的是*下一跳*，不是终点。
      "--write-out",
      "%{url_effective}",
      "--max-time",
      String(options.timeoutSec),
      ...headerArgs(options.headers),
      url,
    ];
    // 用异步 spawn 而不是 spawnSync：探测是并发发起的（多镜像竞速），spawnSync 会把
    // 整个事件循环按 timeoutSec+5 秒卡住，N 个镜像就串行成 N 倍的时间。
    const result = await new Promise((resolve) => {
      const child = spawn(curl.path, args, { cwd: slot.dir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-8192);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-8192);
      });
      // curl 自己带 `--max-time`，这里再兜一层：万一它卡在别处，进程也不能留着
      const timer = setTimeout(() => {
        child.kill();
      }, (options.timeoutSec + 5) * 1000);
      /** @param {{code: number|null, signal: string|null, stdout: string, stderr: string, error: Error|null}} value */
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.on("error", (error) => settle({ code: null, signal: null, stdout, stderr, error }));
      child.on("close", (code, signal) => settle({ code, signal, stdout, stderr, error: null }));
    });
    if (result.error) throw new SourceError(`调用 curl 失败：${result.error.message}`, { cause: result.error });
    if (result.code !== 0) {
      throw new SourceError(`curl 探测失败（exit ${result.code ?? result.signal}）：${(result.stderr || "").trim()}`);
    }
    const blocks = parseHeaderFile(slot.file);
    const last = blocks[blocks.length - 1];
    if (!last) throw new SourceError("curl 没有返回任何响应头");
    if (last.status >= 400) throw new SourceError(`${url} 返回 HTTP ${last.status}`);

    const contentRange = parseContentRange(last.headers["content-range"]);
    const acceptRanges = String(last.headers["accept-ranges"] ?? "").toLowerCase().includes("bytes");
    const effective = String(result.stdout ?? "").trim();
    const finalUrl = /^https?:\/\//i.test(effective) ? effective : url;
    // 206 用 Content-Range 的总量；200（服务端忽略 Range）退到 Content-Length。
    // 旧实现在 200 时 size 恒为 null，于是 auto 传输回退到 curl 会让大小静默变未知。
    const size = last.status === 206 && contentRange?.total != null ? contentRange.total : declaredLength(last.headers);
    return {
      url,
      finalUrl,
      size,
      acceptRanges: last.status === 206 ? true : acceptRanges,
      filename: sanitizeFilename(filenameFromHeaders(last.headers, finalUrl)),
      contentType: last.headers["content-type"] ?? null,
      etag: last.headers["etag"] ?? null,
      lastModified: last.headers["last-modified"] ?? null,
      transport: "curl",
    };
  } finally {
    rmSync(slot.file, { force: true });
  }
}

/** @param {Record<string,string>|undefined} headers */
function headerArgs(headers) {
  const args = [];
  for (const [name, value] of Object.entries({ ...headers, "user-agent": USER_AGENT, "accept-encoding": "identity" })) {
    args.push("--header", `${name}: ${value}`);
  }
  return args;
}

/**
 * 给 curl 的 `--dump-header` 分配落点：返回相对文件名 + 要用作 cwd 的目录。
 *
 * 为什么要绕这一下（本机实测的坑）：Windows 版 curl 用 ANSI 代码页解释命令行里的路径，
 * 而 `%TEMP%` 常常含中文用户名（`C:\Users\<中文>\AppData\Local\Temp`），非 ASCII 路径
 * 传到 curl 里会变成乱码（`C:\Users\<乱码>\...`），curl 建不了文件并报
 * `EPERM, Permission denied`（错误文本里能看到同一个路径的两种编码，一眼可辨）。
 * 改成「cwd 交给 Node 用 UTF-16 传、`-D` 只给纯 ASCII 相对名」就绕开了这条路。
 * @param {{tempDir?: string}} options
 */
function headerSlot(options) {
  const dir = options.tempDir ?? tmpdir();
  mkdirSync(dir, { recursive: true });
  // 名字必须足够独特，不能只用 pid+进程内计数器：worker_threads 下各 worker 的 pid
  // 相同、计数器都从 0 开始，会互相踩；更现实的是「新进程撞上旧进程留下的同名文件」——
  // 头部循环每 20ms 读一次同一路径，curl 还没创建文件时读到的是上一次运行残留的
  // 响应头，于是把旧的 206/200 当成这次的响应（本机实测残留 27 个 .hdr，其中 1 个
  // 末块正好是 206，会被当成合法定稿）。
  const name = `ghpull-hdr-${process.pid}-${curlCounter++}-${Math.random().toString(36).slice(2, 8)}.hdr`;
  const file = path.join(dir, name);
  rmSync(file, { force: true }); // 万一还是撞名：spawn 之前先清掉，绝不读旧内容
  return { dir, name, file };
}

/**
 * 这块响应头是否已经「定稿」，可以据此决定后续动作。
 *
 * 为什么不能只看「status >= 200」：`-L` 跟随跳转时，dump 文件先写中间跳转那一块，
 * 再追加最终响应那一块。GitHub 发布包就是 `302 → objects.githubusercontent.com`，
 * 早先的写法会把 302 当成最终响应，误判成「不支持分段」，还顺手把 curl 杀了。
 * 另外 206 必须能解析出 `Content-Range` 才算定稿，避免读到只写了一半的响应头。
 * @param {{status: number, headers: Record<string,string>}} block
 */
function isFinalResponse(block) {
  const { status } = block;
  if (status >= 100 && status < 200) return false;
  if (status >= 300 && status < 400) return false;
  if (status === 206) return parseContentRange(block.headers["content-range"]) !== null;
  return true;
}

/**
 * 解析 curl `--dump-header` 文件：可能含多个响应头块（重定向链），返回全部。
 *
 * 只返回**写完的**块：末段没有以空行收尾时说明 curl 正在写这一块，里面的
 * `Content-Length` / `Content-Range` 可能是截断值（实测能把 `/100000` 读成 `/100`）。
 * 宁可让轮询再等 20ms，也不能拿半截响应头去决定「这段数据要收多少字节」。
 * @param {string} file
 */
export function parseHeaderFile(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const parts = text.split(/\r?\n\r?\n/);
  if (!/(?:\r?\n){2}\s*$/.test(text)) parts.pop();
  /** @type {{status: number, headers: Record<string,string>}[]} */
  const blocks = [];
  for (const chunk of parts) {
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0]);
    if (!statusMatch) continue;
    /** @type {Record<string,string>} */
    const headers = {};
    for (const line of lines.slice(1)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    blocks.push({ status: Number(statusMatch[1]), headers });
  }
  return blocks;
}

/**
 * 打开一个 Range 请求，返回可迭代的字节流。
 *
 * @param {string} url
 * @param {{start: number, end: number, transport?: string, timeoutSec?: number, maxSockets?: number, curlPath?: string, headers?: Record<string,string>, signal?: AbortSignal, startupTimeoutMs?: number}} options
 * @returns {Promise<{status: number, total: number|null, bytes: AsyncIterable<Buffer>, abort: () => void, finished: Promise<void>, transport: string}>}
 */
export async function openRange(url, options) {
  const transport = options.transport ?? "auto";
  if (transport === "curl") return openRangeCurl(url, options);
  if (transport === "node") return openRangeNode(url, options);
  try {
    return await openRangeNode(url, options);
  } catch (error) {
    if (!isCertificateError(error)) throw error;
    const curl = detectCurl(options.curlPath);
    if (!curl) throw error;
    options.onFallback?.("curl");
    return openRangeCurl(url, options);
  }
}

/**
 * 把响应体包成「会数字节的可迭代流」，并跟踪收尾。
 *
 * 三条纪律（都是被真实事故逼出来的）：
 *  1. **必须数字节**。唯一被校验的是服务端*声明*的 `Content-Range`，声明合法但 body
 *     短了/长了（且 `Content-Length` 与 body 自洽）时协议层没有任何错误，只 await
 *     `finished` 的调用方会把截断的分片当成完成，拼装后静默缺字节。所以 `finished`
 *     只在「实收字节数 == 期望字节数」时 resolve。
 *  2. **取消必须 reject**。取消时旧实现把 `res.destroy()` 后的 `close` 当成正常结束
 *     resolve 出去，于是迭代器抛 `ERR_STREAM_PREMATURE_CLOSE`、`finished` 却报成功，
 *     两个信号互相矛盾——只 await `finished` 的调用方会把半个分片标记成完成。
 *  3. 错误既要经由 `bytes` 的迭代异常暴露，也要让 `finished` reject。返回的 Promise
 *     在这里先被「消费」一次（空 catch），否则没人 await 时 Node 会把拒绝当成未处理
 *     拒绝并**直接终止进程**（真机表现：reset 或看门狗 abort 后进程猝死，只打一行
 *     `Error: aborted ... code: 'ECONNRESET'`，连重试的机会都没有）；空 catch 不改变
 *     真正 await 它的调用方拿到的结果。
 *
 * @param {import("node:http").IncomingMessage|import("node:stream").Readable} source
 * @param {number|null} expected 期望字节数；`null` 表示长度未知，跳过数量校验
 * @param {{isAborted: () => boolean, detach?: () => void}} ctx
 * @returns {{bytes: AsyncIterable<Buffer>, finished: Promise<void>}}
 */
function makeBody(source, expected, ctx) {
  let received = 0;
  const bytes = (async function* () {
    for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (source)) {
      received += /** @type {Buffer} */ (chunk).length;
      yield /** @type {Buffer} */ (chunk);
    }
  })();

  const finished = new Promise((resolve, reject) => {
    const settle = () => {
      ctx.detach?.();
      if (ctx.isAborted()) return reject(new GhpullError("已取消"));
      if (expected !== null && received !== expected) {
        return reject(
          new SourceError(`响应体字节数与请求不符：收到 ${received} 字节，应为 ${expected} 字节（连接被提前关闭或服务端截断）`),
        );
      }
      resolve();
    };
    source.on("end", settle);
    source.on("close", settle);
    source.on("error", (error) => {
      ctx.detach?.();
      // 取消是我们自己发起的：信号触发的流错误（ECONNRESET / aborted）不该被
      // 报成网络故障，否则上层会把它当成「这个来源坏了」而淘汰一个健康来源。
      if (ctx.isAborted()) return reject(new GhpullError("已取消"));
      reject(error);
    });
    // 流在这之前就已经结束（Windows 上子进程退出后才去读 piped stdout 就是这个下场）：
    // end/close 都已经发过，再挂监听器就永远等不到，finished 会挂死。这里直接结算，
    // 实收字节对不上就如实报错，而不是无声挂起。
    if (source.readableEnded || source.destroyed) settle();
  });
  finished.catch(() => {});
  return { bytes, finished };
}

/**
 * 把「信号取消」接到 abort 回调上，并返回摘除函数。
 *
 * node 传输里 `signal` 也交给了 `http.request`，Node 自己取消时用的是
 * `ECONNRESET` / `Error: aborted` 炸掉响应流，我们自己的 `aborted` 标志并不会被置上，
 * 于是「用户按了 Ctrl-C」会被报成网络错误。这里显式接线，顺便保证监听器不残留在
 * 调用方的 signal 上（同一个 signal 可能被多次 range 请求复用，不摘会越攒越多）。
 * @param {AbortSignal|undefined} signal
 * @param {() => void} onAbort
 * @returns {(() => void)|undefined}
 */
function watchSignalAbort(signal, onAbort) {
  if (!signal) return undefined;
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * 非 206 的 Range 响应该怎么报。
 *
 * `>= 400` 是「这个来源这次失败了」（404/429/5xx 都可能只是暂时状态），
 * 不是「它不支持分段」；旧实现一律报 `UnsupportedError`，把 404 说成
 * 「该来源不支持分段下载」，既误导用户，也误导上层的来源淘汰逻辑。
 * @param {string} url
 * @param {number} status
 */
function rangeStatusError(url, status) {
  if (status >= 400) return new SourceError(`${url} 对 Range 请求返回 HTTP ${status}`);
  return new UnsupportedError(`${url} 对 Range 请求返回 HTTP ${status}（期望 206），该来源不支持分段下载`);
}

/** node 实现的 Range 读取。 */
async function openRangeNode(url, options) {
  const { res, finalUrl, cleanup } = await requestOnce(url, {
    method: "GET",
    headers: { ...baseHeaders(options.headers), range: `bytes=${options.start}-${options.end}` },
    timeoutSec: options.timeoutSec ?? 30,
    maxSockets: options.maxSockets ?? 16,
    signal: options.signal,
  });

  let aborted = false;
  const abort = () => {
    aborted = true;
    cleanup();
  };

  const status = res.statusCode ?? 0;
  const contentRange = parseContentRange(/** @type {string|undefined} */ (res.headers["content-range"]));

  if (status === 416) {
    cleanup();
    throw new SourceError(`${finalUrl} 返回 416（请求区间超出资源范围）`);
  }
  // 单流兜底模式：请求的就是整个资源，服务端回 200（而不是 206）也算数
  if (status === 200 && options.allowFullResponse === true && options.start === 0) {
    const declared = Number(res.headers["content-length"]);
    const detach = watchSignalAbort(options.signal, abort);
    const body = makeBody(res, Number.isFinite(declared) && declared >= 0 ? declared : null, {
      isAborted: () => aborted,
      detach,
    });
    return {
      status,
      total: Number.isFinite(declared) ? declared : null,
      bytes: body.bytes,
      abort,
      finished: body.finished,
      transport: "node",
    };
  }
  if (status !== 206) {
    cleanup();
    throw rangeStatusError(finalUrl, status);
  }
  if (!contentRange || contentRange.start !== options.start || contentRange.end !== options.end) {
    cleanup();
    throw new SourceError(
      `${finalUrl} 返回的 Content-Range 与请求不一致：期望 ${options.start}-${options.end}，实际 ${res.headers["content-range"]}`,
    );
  }

  const detach = watchSignalAbort(options.signal, abort);
  const body = makeBody(res, options.end - options.start + 1, { isAborted: () => aborted, detach });
  return {
    status,
    total: contentRange.total,
    bytes: body.bytes,
    abort,
    finished: body.finished,
    transport: "node",
  };
}

/** 把 curl 的 stderr 末尾一行拼进错误信息：真因（连接被拒、证书、DNS）几乎都在那里。 */
function stderrTail(stderr) {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const tail = lines[lines.length - 1] ?? "";
  return tail ? `：${tail}` : "";
}

/** curl 实现的 Range 读取：curl 写 stdout，Node 逐块读走。 */
async function openRangeCurl(url, options) {
  const curl = detectCurl(options.curlPath);
  if (!curl) throw new SourceError("没有找到可用的 curl");
  if (options.signal?.aborted) throw new GhpullError("已取消");

  const slot = headerSlot(options);
  // 传输期停滞保护：curl 在 `--speed-time` 窗口内的平均速率低于 `--speed-limit` 就退出 28。
  // 没有它的话，响应头已到、body 半开（黑洞）时 curl 会永远挂着、finished 永不 settle ——
  // node 侧有 req.setTimeout 兜底，两条传输的行为必须一致。
  const stallSec = Math.max(5, options.stallSec ?? 30);
  const args = [
    "-sS",
    "-L",
    "--range",
    `${options.start}-${options.end}`,
    "--dump-header",
    slot.name,
    "--output",
    "-",
    "--connect-timeout",
    String(Math.max(5, Math.min(options.timeoutSec ?? 30, 30))),
    "--speed-limit",
    "1",
    "--speed-time",
    String(stallSec),
    ...headerArgs(options.headers),
    url,
  ];
  const child = spawn(curl.path, args, { cwd: slot.dir, stdio: ["ignore", "pipe", "pipe"] });
  // 立刻用 PassThrough 接管 stdout，别等头部阶段结束再去读。
  // Windows 上给子进程的 pipe 在子进程退出后就会丢数据：实测「spawn 后立刻读」拿得到 10 字节，
  // 「延迟 300ms 再读」和「先 pause 再读」都是 0 字节。而头部阶段至少要轮询一次（20ms），
  // 本地服务下 curl 常常 10~14ms 就退出了 ⇒ body 恒为空，且流已 end/close，makeBody 的
  // end/close 监听永不触发，finished 永不 settle。PassThrough 在 spawn 后立刻接管就不会漏，
  // 没人消费时它的背压会一路传回 curl（内存有界，不会把整个响应体攒进进程）。
  const bodyStream = new PassThrough();
  child.stdout?.pipe(bodyStream);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  let aborted = false;
  const abort = () => {
    aborted = true;
    child.kill();
  };
  const detach = () => options.signal?.removeEventListener("abort", abort);
  options.signal?.addEventListener("abort", abort, { once: true });

  // spawn 异步失败（EMFILE 之类）时没人接 'error' 就是未处理事件 → 进程直接猝死；
  // 头部等待循环里还要能立刻发现「curl 已经退出」，否则真因（连接被拒、404）会被
  // 拖成「20 秒没有返回响应头」这种毫无信息量的报错。
  /** @type {Error|null} */
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  /** @type {{code: number|null, signal: string|null}|null} */
  let exitInfo = null;
  let exitedAt = 0;
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    exitedAt = Date.now();
  });

  // 退出承诺必须**在头部阶段之前**挂好：curl 可能在两次轮询的空档里就退出并触发
  // `close`，等头部阶段结束后再挂监听器就永远等不到，`finished` 永不 settle（挂死）。
  const exit = new Promise((resolve, reject) => {
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new SourceError(`curl 退出码 ${code ?? signal}${stderrTail(stderr)}`));
    });
    child.on("error", reject);
  });
  exit.catch(() => {});

  // 清理尽力而为：curl 刚被 kill 时句柄可能还没释放，Windows 上此刻 unlink 会抛 EPERM，
  // 把真正的失败原因（例如服务器回了 302）整个盖掉。删不掉就等 close 时再删一次。
  //
  // 但 `close` 时**不能无条件删**：dump-header 是 curl 退出时才刷完的，而本地服务
  // 响应极快（实测 close@9~13ms），头部阶段的轮询（每 20ms 一次）往往还没读到文件，
  // 文件就没了 —— 于是报出「curl 还没返回响应头就退出了（退出码 0）」这种看不懂的错。
  // 真因实测（`tmp-race-probe.mjs`，3 轮）：close 里立刻删 → 3/3 轮读不到响应头；
  // 不删 → 3/3 轮都在 22~36ms 读到 206。所以只在头部阶段结束后才允许删。
  let headerGone = false;
  let headerPhaseDone = false;
  const cleanupHeader = () => {
    if (headerGone || !headerPhaseDone) return;
    try {
      rmSync(slot.file, { force: true });
      headerGone = true;
    } catch {
      /* 句柄未释放：留给 close 回调或系统临时目录回收 */
    }
  };
  child.on("close", cleanupHeader);

  const startupTimeoutMs = options.startupTimeoutMs ?? 20000;
  const deadline = Date.now() + startupTimeoutMs;
  /** @type {{status: number, headers: Record<string,string>}|null} */
  let block = null;
  /** 期望字节数与总量：206 用请求区间长度，整包用 Content-Length */
  let expected = null;
  /** @type {number|null} */
  let total = null;

  // 头部阶段的所有 throw 路径都要摘掉 abort 监听器，否则同一条 signal 上每失败一次
  // 就泄漏一个监听器（curl 侧实测泄漏到 14 个，11 个起开始刷 MaxListenersExceededWarning，
  // 每个还钉住一个 child 和它的 stderr 缓冲）。
  try {
    while (block === null) {
      if (aborted) throw new GhpullError("已取消");
      if (spawnError) throw new SourceError(`启动 curl 失败：${spawnError.message}`, { cause: spawnError });
      const blocks = parseHeaderFile(slot.file);
      const candidate = blocks[blocks.length - 1];
      if (candidate && isFinalResponse(candidate)) {
        block = candidate;
      } else if (exitInfo) {
        // curl 退出之后 dump-header 才可能落盘：写盘发生在进程退出时，而本地服务
        // 响应极快，curl 完全可能赶在轮询之前就结束（真机现象：退出码 0 却报
        // 「还没返回响应头就退出了」）。留一小段宽限再判定，宽限内仍读不到才认为
        // 真失败——这时 stderr 末行才是真因（连接被拒、404 等）。
        if (Date.now() - exitedAt < EXIT_GRACE_MS) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw new SourceError(
          `curl 还没返回响应头就退出了（退出码 ${exitInfo.code ?? "null"}${
            exitInfo.signal ? `，信号 ${exitInfo.signal}` : ""
          }）${stderrTail(stderr)}`,
        );
      } else if (Date.now() > deadline) {
        throw new SourceError(`curl 在 ${Math.round(startupTimeoutMs / 1000)}s 内没有返回响应头${stderrTail(stderr)}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    if (block.status === 416) throw new SourceError(`${url} 返回 416（请求区间超出资源范围）`);
    const wholeFile = block.status === 200 && options.allowFullResponse === true && options.start === 0;
    if (block.status !== 206 && !wholeFile) throw rangeStatusError(url, block.status);

    if (block.status === 206) {
      const contentRange = parseContentRange(block.headers["content-range"]);
      if (!contentRange || contentRange.start !== options.start || contentRange.end !== options.end) {
        throw new SourceError(
          `${url} 返回的 Content-Range 与请求不一致：期望 ${options.start}-${options.end}，实际 ${block.headers["content-range"]}`,
        );
      }
      expected = options.end - options.start + 1;
      total = contentRange.total;
    } else {
      const declared = Number(block.headers["content-length"]);
      expected = Number.isFinite(declared) && declared >= 0 ? declared : null;
      total = expected;
    }
  } catch (error) {
    headerPhaseDone = true;
    detach();
    child.kill();
    cleanupHeader();
    throw error;
  }
  // 头部阶段结束，响应头已经落到了 `block` 里，临时文件可以收了
  headerPhaseDone = true;
  cleanupHeader();

  const body = makeBody(bodyStream, expected, { isAborted: () => aborted, detach });
  const finished = (async () => {
    const [bodyResult, exitResult] = await Promise.allSettled([body.finished, exit]);
    detach();
    if (aborted) throw new GhpullError("已取消");
    if (bodyResult.status === "rejected") throw bodyResult.reason;
    if (exitResult.status === "rejected") throw exitResult.reason;
  })();
  // 未处理的 rejection 会在进程退出时刷屏；由调用方决定是否吞掉
  finished.catch(() => {});

  return {
    status: block.status,
    total,
    bytes: body.bytes,
    abort,
    finished,
    transport: "curl",
  };
}
