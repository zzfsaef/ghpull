// SPDX-License-Identifier: MIT
/** 测试用的本地 HTTP 服务与确定性数据。 */

import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

/**
 * 生成确定性伪随机内容（避免全 0 数据掩盖偏移错误）。
 * @param {number} size
 * @param {number} [seed]
 */
export function makeBody(size, seed = 7) {
  const buffer = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer[index] = (state >>> 24) & 0xff;
  }
  return buffer;
}

/** @param {Buffer|string} data */
export function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 起一个支持 Range 的本地服务。
 *
 * @param {{
 *   body?: Buffer,
 *   size?: number,
 *   ignoreRange?: boolean,
 *   delayMs?: number,
 *   failFirst?: number,
 *   truncateEvery?: number,
 *   chunkBytes?: number,
 *   chunkDelayMs?: number,
 *   slowAfterBytes?: number,
 *   slowChunkBytes?: number,
 *   slowChunkDelayMs?: number,
 *   slowRange?: [number, number],
 *   noAcceptRangesHeader?: boolean,
 *   etag?: string,
 *   stallAfterBytes?: number,
 * }} [options]
 */
export async function startServer(options = {}) {
  const body = options.body ?? makeBody(options.size ?? 256 * 1024);
  const etag = options.etag ?? '"v1"';
  const state = { requests: 0, rangeRequests: 0, ranges: /** @type {[number, number][]} */ ([]), failures: 0 };
  const openResponses = new Set();
  let remainingFailures = options.failFirst ?? 0;
  const truncateEvery = options.truncateEvery ?? 0;

  const server = http.createServer((req, res) => {
    state.requests += 1;
    const range = req.headers.range;

    if (options.ignoreRange === true) {
      res.writeHead(200, { "content-length": String(body.length), "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-length": String(body.length),
        "accept-ranges": options.noAcceptRangesHeader === true ? "none" : "bytes",
        etag,
        "content-type": "application/octet-stream",
      });
      res.end();
      return;
    }

    if (!range) {
      res.writeHead(200, { "content-length": String(body.length), etag });
      res.end(body);
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? body.length - 1 : Number(match[2]);
    if (start >= body.length || end >= body.length || start > end) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
    state.rangeRequests += 1;
    state.ranges.push([start, end]);

    // 前 N 个请求只发一半就掐断，用来验证「重试 + 续传」。
    // `bytes=0-0` 是探测阶段的元数据请求（只取 1 字节确认分段能力），不算数据请求：
    // 让 failFirst 落在真正的分段请求上，否则探测会把配额吃掉，测不到分段级重试。
    const isProbe = start === 0 && end === 0;
    // truncateEvery=N：每第 N 个数据请求就掐断一次，用来做「截断 + 重试 + 切分」压力测试。
    // 只有零散的一两次截断测不出问题：真正会出错的是「边下边切分」和「截断后从
    // 半路续写」同时发生时，分片文件被写多/写重。
    const shouldFail =
      (remainingFailures > 0 && !isProbe) || (truncateEvery > 0 && !isProbe && state.rangeRequests % truncateEvery === 0);
    if (shouldFail) {
      remainingFailures -= 1;
      state.failures += 1;
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": String(end - start + 1),
        etag,
      });
      res.write(body.subarray(start, start + Math.max(1, Math.floor((end - start + 1) / 2))));
      res.destroy();
      return;
    }

    const send = () => {
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        etag,
      });
      // 只发一部分就把连接晾着：逼调用方自己判断「停滞」并中止在途请求。
      if (options.stallAfterBytes !== undefined) {
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        res.write(body.subarray(start, start + options.stallAfterBytes));
        return;
      }
      const slice = body.subarray(start, end + 1);
      // chunkBytes/chunkDelayMs：把正文切成小块、每块之间等一会儿再发。
      // 用来模拟慢链路——`res.end(整个分片)` 会让一次分段下载只占几个事件循环轮次，
      // 而「边下边切分」这类竞态只有在写循环**长期处于进行中**时才可能发生
      // （真机是 42 KB/s、一个 8MB 分段要下几分钟）。
      // slowRange=[from, to]（含端点）：只有落在这个字节区间里的请求才走慢速，
      // 于是「其它分段都下完了、只剩区间里那几段还在慢慢爬」这种局面可以稳定复现——
      // 那正是「切分切到一条正在写的分段上」的必要条件。
      const inSlowRange =
        options.slowRange !== undefined && start >= options.slowRange[0] && start <= options.slowRange[1];
      if (options.chunkBytes && (options.slowRange === undefined || inSlowRange)) {
        const delay = options.chunkDelayMs ?? 10;
        const slowAfter = options.slowAfterBytes;
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        let offset = 0;
        const pump = () => {
          if (res.destroyed || res.writableEnded || res.writableFinished) return;
          if (offset >= slice.length) {
            res.end();
            return;
          }
          // slowAfterBytes：这一条响应写够这么多字节之后换成慢速参数。
          // 真机上「前 90% 很快、末段被饿住」很常见（自适应闸门就是为它准备的），
          // 而 slowRange 只能按请求起点分快慢，复现不出「同一条连接中途变慢」。
          const slow = slowAfter !== undefined && start + offset >= slowAfter;
          const size = slow ? options.slowChunkBytes ?? options.chunkBytes : options.chunkBytes;
          const wait = slow ? options.slowChunkDelayMs ?? delay : delay;
          const next = Math.min(offset + size, slice.length);
          res.write(slice.subarray(offset, next));
          offset = next;
          if (offset >= slice.length) res.end();
          else setTimeout(pump, wait);
        };
        setTimeout(pump, delay);
        return;
      }
      res.end(slice);
    };
    if (options.delayMs) setTimeout(send, options.delayMs);
    else send();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${address.port}/file.bin`,
    body,
    etag,
    state,
    close: async () => {
      for (const res of openResponses) res.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** 临时目录，测试结束自动清理。 */
export async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ghpull-test-"));
  return {
    dir,
    file: (name) => path.join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
