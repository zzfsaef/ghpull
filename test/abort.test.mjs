// 回归用例：取消（abort）之后 finished 必须结算，哪怕调用方压根没读过 bytes。
//
// 背景（真事故）：curl 传输改用 PassThrough 接管 stdout 之后，`abort()` 只 kill 了子进程，
// 没有销毁 bodyStream。PassThrough 的 readable 侧只有在被读取时才会 end/close，于是
// 「开了流却不读、直接 abort 再 await finished」这一种顺序下 finished 永久 pending ——
// 调用方（引擎竞速/用户取消/目的文件已存在）会一直挂着。node 传输没这个问题，因为它的
// cleanup() 会 destroy 响应流，所以这是跨传输不一致。
//
// 服务端必须是独立进程：本机 curl 打不到同进程内的服务。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeAgents, detectCurl, openRange } from "../src/index.mjs";

const SERVER_CODE = `
import http from "node:http";
const server = http.createServer((req, res) => {
  res.writeHead(206, {
    "content-type": "application/octet-stream",
    "content-range": "bytes 0-1999/100000",
    "content-length": "2000",
  });
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= 2000) {
      clearInterval(timer);
      res.end();
      return;
    }
    sent += 100;
    res.write(Buffer.alloc(100, 7));
  }, 100);
  req.on("close", () => clearInterval(timer));
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + server.address().port + "\\n"));
`;

/** 起一个慢速 206 服务端（每 100ms 吐 100 字节，最长约 2 秒）。 */
async function startSlowServer() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", SERVER_CODE], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("慢速服务端 5s 内没有起来")), 5000);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /PORT=(\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { url: `http://127.0.0.1:${port}/big.bin`, close: () => child.kill() };
}

/** 开了流、不读、abort，然后 finished 必须在 3 秒内以「已取消」reject。 */
async function assertAbortSettles(t, transport) {
  if (transport === "curl" && !detectCurl()) {
    t.skip("本机没有可用的 curl");
    return;
  }
  const server = await startSlowServer();
  try {
    const stream = await openRange(server.url, { transport, start: 0, end: 1999, timeoutSec: 10 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.abort();
    const outcome = await Promise.race([
      stream.finished.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("PENDING"), 3000)),
    ]);
    assert.notEqual(outcome, "PENDING", `${transport}：abort() 之后 finished 必须结算，不能永久 pending`);
    assert.notEqual(outcome, "resolved", `${transport}：被取消的流不能报成功`);
    assert.equal(outcome.constructor.name, "GhpullError");
    assert.match(outcome.message, /已取消/);
  } finally {
    server.close();
  }
}

test("取消（node）：没读过 bytes 也要让 finished 以「已取消」结算", async (t) => {
  await assertAbortSettles(t, "node");
});

test("取消（curl）：没读过 bytes 也要让 finished 以「已取消」结算", async (t) => {
  await assertAbortSettles(t, "curl");
});

after(() => closeAgents());
