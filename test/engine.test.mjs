// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { withDefaults } from "../src/args.mjs";
import { Engine } from "../src/engine.mjs";
import { ChecksumError, DestinationExistsError } from "../src/errors.mjs";
import { makeBody, makeTempDir, sha256Of, startServer } from "./helpers.mjs";

/** @param {string} url @param {string} out @param {Record<string, unknown>} [extra] */
function options(url, out, extra = {}) {
  return withDefaults({
    url,
    out,
    conns: 4,
    maxConns: 8,
    minSplit: 64 * 1024,
    stallSec: 5,
    timeoutSec: 10,
    retries: 3,
    transport: "node",
    ...extra,
  });
}

test("完整下载：内容一致、哈希自证、真的并发了", async () => {
  const server = await startServer({ size: 512 * 1024, delayMs: 5 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const result = await new Engine(options(server.url, out), {}).run();

    assert.equal(result.ok, true);
    assert.equal(result.bytes, server.body.length);
    assert.equal(result.sha256, sha256Of(server.body));
    assert.equal(result.transport, "node");
    assert.ok(result.peakConns > 1, `peakConns=${result.peakConns} 应大于 1`);
    assert.ok(result.reusedBytes === 0);
    assert.equal(result.fetchedBytes, server.body.length);
    assert.deepEqual(await readFile(out), server.body);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("已存在的输出文件：拒绝覆盖，且一个请求都没发", async () => {
  const server = await startServer({ size: 64 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    await writeFile(out, "SENTINEL", "utf8");

    const error = await new Engine(options(server.url, out), {}).run().then(
      () => null,
      (caught) => caught,
    );

    assert.ok(error instanceof DestinationExistsError);
    assert.equal(error.code, 3);
    assert.equal(server.state.requests, 0, "覆盖保护必须在联网之前生效");
    assert.equal(await readFile(out, "utf8"), "SENTINEL");
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("--force 覆盖已存在的文件", async () => {
  const server = await startServer({ size: 96 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    await writeFile(out, "OLD", "utf8");
    const result = await new Engine(options(server.url, out, { force: true }), {}).run();
    assert.equal(result.ok, true);
    assert.deepEqual(await readFile(out), server.body);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("哈希不匹配：报 ChecksumError(4)，且不留下目标文件", async () => {
  const server = await startServer({ size: 64 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const error = await new Engine(options(server.url, out, { sha256: "a".repeat(64) }), {}).run().then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof ChecksumError);
    assert.equal(error.code, 4);
    await assert.rejects(() => readFile(out), /ENOENT/);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("哈希匹配时正常完成", async () => {
  const server = await startServer({ size: 128 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const result = await new Engine(
      options(server.url, out, { sha256: sha256Of(server.body).toUpperCase() }),
      {},
    ).run();
    assert.equal(result.ok, true);
    assert.equal(result.sha256, sha256Of(server.body));
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("中途断连：自动重试后仍拿到完整文件", async () => {
  const server = await startServer({ size: 256 * 1024, failFirst: 2 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const result = await new Engine(options(server.url, out), {}).run();
    assert.equal(result.ok, true);
    assert.equal(server.state.failures, 2, "服务端应该确实掐断过两次");
    assert.deepEqual(await readFile(out), server.body);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("服务端不支持 Range：退化成单流，内容仍然正确", async () => {
  const server = await startServer({ size: 128 * 1024, ignoreRange: true });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const result = await new Engine(options(server.url, out), {}).run();
    assert.equal(result.ok, true);
    assert.equal(result.sha256, sha256Of(server.body));
    assert.equal(server.state.rangeRequests, 0, "单流模式下不应发 Range 请求");
    assert.deepEqual(await readFile(out), server.body);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("空资源：落下 0 字节文件并给出空内容的 sha256", async () => {
  const server = await startServer({ body: Buffer.alloc(0) });
  const temp = await makeTempDir();
  try {
    const out = temp.file("empty.bin");
    const result = await new Engine(options(server.url, out), {}).run();
    assert.equal(result.bytes, 0);
    assert.equal(result.sha256, sha256Of(Buffer.alloc(0)));
    assert.equal((await readFile(out)).length, 0);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("续传：保留分片后重跑，直接复用已下载的字节", async () => {
  const server = await startServer({ size: 256 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const first = await new Engine(options(server.url, out, { keepParts: true }), {}).run();
    assert.equal(first.reusedBytes, 0);

    await rm(out, { force: true });
    const rangeRequestsBefore = server.state.rangeRequests;

    const second = await new Engine(options(server.url, out, { continueDownload: true }), {}).run();
    assert.equal(second.reusedBytes, server.body.length, "应全部复用");
    assert.equal(second.fetchedBytes, 0);
    // 第二次运行只允许发探测用的 `bytes=0-0`（确认来源仍然支持分段），不能重取任何分段
    const newRanges = server.state.ranges.slice(rangeRequestsBefore);
    assert.deepEqual(newRanges, [[0, 0]], "复用时不应再取任何分段数据");
    assert.deepEqual(await readFile(out), server.body);
    assert.equal(second.sha256, sha256Of(server.body));
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("分片文件被截断时不吃坏数据：长度对不上就重下该段", async () => {
  const server = await startServer({ size: 256 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    await new Engine(options(server.url, out, { keepParts: true }), {}).run();
    await rm(out, { force: true });

    // 人为把一个分片截断，模拟「下载中被强杀」后的残片
    const { partFileFor, readState } = await import("../src/state.mjs");
    const state = await readState(out);
    const first = state.segments[0];
    const truncated = partFileFor(out, first.start, first.end);
    await writeFile(truncated, (await readFile(truncated)).subarray(0, 1024));

    const result = await new Engine(options(server.url, out, { continueDownload: true }), {}).run();
    assert.equal(result.ok, true);
    assert.ok(result.reusedBytes < server.body.length, "被截断的段必须重下");
    assert.deepEqual(await readFile(out), server.body);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("结果摘要字段齐全（供 --json 与下游脚本消费）", async () => {
  const server = await startServer({ size: 64 * 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const result = await new Engine(options(server.url, out), {}).run();
    for (const key of [
      "ok",
      "url",
      "out",
      "bytes",
      "elapsedSec",
      "avgBps",
      "reusedBytes",
      "fetchedBytes",
      "fetchBps",
      "peakConns",
      "sources",
      "transport",
      "sha256",
    ]) {
      assert.ok(key in result, `结果里缺字段 ${key}`);
    }
    assert.equal(result.out, out);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("makeBody 是确定性的（同样种子同样内容，换种子换内容）", () => {
  assert.deepEqual(makeBody(64, 1), makeBody(64, 1));
  assert.notDeepEqual(makeBody(64, 1), makeBody(64, 2));
});

test("切分切到正在写的分段上：产物必须与源逐字节一致（分片不许多写、不许重叠）", async () => {
  // 真机基准跑出来的事故：8 连接下产物比真实文件长了 487,739 字节，退出码还是 0，
  // 哈希也「自证通过」——因为哈希算的是那份被写坏的文件。根因是「边下边切分」时，
  // ① 被切分的分段会立刻被放回队列，另一个 worker 抢到同一段、同时打开同一个分片
  //    文件写同一段偏移，两个写入者交错；
  // ② 请求是按切分前的旧 end 发的，越过新 end 的字节照样落盘，而旧版合并整流读取
  //    part 文件，多出来的字节被静默拼进成品。
  // 要复现它，必须让「切分」正好落在一条**正在写**的分段上：服务端把文件中间一段
  // 用 16 KiB/30ms 的速度慢慢吐（模拟真机 42 KB/s），其它分段秒完，于是活跃连接数
  // 掉到上限以下、而剩下的空洞还够大 —— 引擎必然去切那几条正在写的分段。
  const size = 2 * 1024 * 1024;
  const server = await startServer({
    size,
    chunkBytes: 32 * 1024,
    chunkDelayMs: 40,
  });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    /** @type {any[]} */
    const events = [];
    const result = await new Engine(
      options(server.url, out, {
        conns: 2,
        maxConns: 2,
        minSplit: 1024 * 1024,
        retries: 5,
        stallSec: 10,
        timeoutSec: 15,
        lowestSpeed: 0,
      }),
      { onEvent: (event) => events.push(event) },
    ).run();

    const splits = events.filter((event) => event.type === "split");
    const activeSplits = splits.filter((event) => event.active === true);
    assert.ok(splits.length > 0, "本用例必须真的触发切分，否则它什么都没测到");
    assert.ok(activeSplits.length > 0, `切分必须落在正在写的分段上才算复现（active 切分 ${activeSplits.length}/${splits.length}）`);

    assert.equal(result.ok, true);
    assert.equal(result.bytes, size);
    const onDisk = await readFile(out);
    assert.equal(onDisk.length, size, "产物长度必须与声明大小一致");
    assert.equal(result.sha256, sha256Of(server.body));
    assert.deepEqual(onDisk, server.body, "产物必须与源逐字节一致");
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("看门狗中止在途分段：进程不能死在未处理的 Promise 拒绝上", async () => {
  // 真机跑出来的事故：服务端把连接晾住，看门狗 abort() 掉正在传输的请求，
  // 传输层的 finished Promise 以 "aborted/ECONNRESET" 拒绝，但没有任何人 await 它，
  // 于是 Node 按未处理拒绝直接终止进程（stderr 只有一串 "Error: aborted"）。
  // 这里断言的是「失败要走正常错误通道」：要么按来源失败重试，要么抛 NoSourceError。
  const server = await startServer({ size: 256 * 1024, stallAfterBytes: 1024 });
  const temp = await makeTempDir();
  try {
    const out = temp.file("out.bin");
    const error = await new Engine(
      options(server.url, out, { conns: 1, maxConns: 1, stallSec: 1, retries: 1, lowestSpeed: 1 }),
      {},
    )
      .run()
      .then(
        () => null,
        (caught) => caught,
      );

    assert.ok(error, "服务端永远不发完，理应失败而不是成功");
    assert.equal(error.code, 6, `期望 NoSourceError（退出码 6），实际 ${error.code}: ${error.message}`);
    assert.doesNotMatch(String(error.message), /aborted|ECONNRESET/, "不该把传输层的原始拒绝当成用户可见错误");
  } finally {
    await server.close();
    await temp.cleanup();
  }
});
