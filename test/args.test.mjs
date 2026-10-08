// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs, parseCount, parseSize, readConfigFile } from "../src/args.mjs";
import { UsageError } from "../src/errors.mjs";
import { makeTempDir } from "./helpers.mjs";

test("最小用法：只有 URL", () => {
  const options = parseCliArgs(["https://example.com/a.bin"]);
  assert.equal(options.url, "https://example.com/a.bin");
  assert.equal(options.conns, 8);
  assert.equal(options.maxConns, 16);
  assert.equal(options.minSplit, 8 * 1024 * 1024);
  assert.equal(options.stallSec, 12);
  assert.equal(options.mirrorMode, "off");
  assert.equal(options.mirrors.length, 0);
  assert.equal(options.resume, true);
  assert.equal(options.adaptive, true);
  assert.equal(options.json, false);
});

test("--no-adaptive 关掉启动闸门", () => {
  assert.equal(parseCliArgs(["https://e.com/a", "--no-adaptive"]).adaptive, false);
});

test("尺寸解析：单位与 /s 后缀", () => {
  assert.equal(parseSize("64KiB", "t"), 65536);
  assert.equal(parseSize("8M", "t"), 8 * 1024 * 1024);
  assert.equal(parseSize("1M/s", "t"), 1024 * 1024);
  assert.equal(parseSize("1024", "t"), 1024);
  assert.equal(parseSize("2GiB", "t"), 2 * 1024 ** 3);
});

test("计数解析：越界与非法值都抛 UsageError", () => {
  assert.equal(parseCount("4", "t", { min: 1, max: 8 }), 4);
  assert.throws(() => parseCount("0", "t", { min: 1, max: 8 }), UsageError);
  assert.throws(() => parseCount("9", "t", { min: 1, max: 8 }), UsageError);
  assert.throws(() => parseCount("abc", "t", { min: 1, max: 8 }), UsageError);
});

test("max-conns 不能小于 conns", () => {
  assert.throws(() => parseCliArgs(["https://e.com/a", "--conns", "8", "--max-conns", "4"]), UsageError);
});

test("--force 与 --continue 互斥", () => {
  assert.throws(() => parseCliArgs(["https://e.com/a", "--force", "--continue"]), UsageError);
});

test("未知选项报 UsageError（strict）", () => {
  assert.throws(() => parseCliArgs(["https://e.com/a", "--nope"]), UsageError);
});

test("缺少 URL 报 UsageError", () => {
  assert.throws(() => parseCliArgs([]), UsageError);
  assert.throws(() => parseCliArgs(["--conns", "4"]), UsageError);
});

test("多个位置参数报 UsageError", () => {
  assert.throws(() => parseCliArgs(["https://e.com/a", "https://e.com/b"]), UsageError);
});

test("--mirror-mode manual 需要至少一个 --mirror", () => {
  assert.throws(() => parseCliArgs(["https://e.com/a", "--mirror-mode", "manual"]), UsageError);
  const options = parseCliArgs(["https://e.com/a", "--mirror-mode", "manual", "--mirror", "https://m/{url}"]);
  assert.deepEqual(options.mirrors, ["https://m/{url}"]);
});

test("配置文件的值当默认值，命令行优先", () => {
  const base = { conns: 3, minSplit: "1MiB", stallSec: 20, mirrors: ["https://m/{url}"], mirrorMode: "manual" };
  const fromConfig = parseCliArgs(["https://e.com/a"], base);
  assert.equal(fromConfig.conns, 3);
  assert.equal(fromConfig.minSplit, 1024 * 1024);
  assert.equal(fromConfig.stallSec, 20);
  assert.deepEqual(fromConfig.mirrors, ["https://m/{url}"]);

  const overridden = parseCliArgs(["https://e.com/a", "--conns", "6"], base);
  assert.equal(overridden.conns, 6);
  assert.equal(overridden.minSplit, 1024 * 1024);
});

test("读配置文件：非法 JSON 与缺失文件都抛 UsageError", async () => {
  const temp = await makeTempDir();
  try {
    const good = temp.file("ok.json");
    const bad = temp.file("bad.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(good, '{"conns": 2}', "utf8");
    await writeFile(bad, "{ not json", "utf8");
    assert.deepEqual(await readConfigFile(good), { conns: 2 });
    await assert.rejects(() => readConfigFile(bad), UsageError);
    await assert.rejects(() => readConfigFile(temp.file("missing.json")), UsageError);
  } finally {
    await temp.cleanup();
  }
});
