// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import { compareHash, parseExpectedHash, sha256File, sizeOf } from "../src/verify.mjs";
import { makeBody, makeTempDir, sha256Of } from "./helpers.mjs";

test("parseExpectedHash：大小写归一、sha256: 前缀、长度校验", () => {
  const hash = "a".repeat(64);
  assert.equal(parseExpectedHash(hash.toUpperCase()), hash);
  assert.equal(parseExpectedHash(`sha256:${hash}`), hash);
  assert.throws(() => parseExpectedHash("deadbeef"), /64/);
  assert.throws(() => parseExpectedHash("z".repeat(64)), /十六进制|hex/i);
});

test("sha256File 与 sizeOf：与内存计算一致", async () => {
  const temp = await makeTempDir();
  try {
    const body = makeBody(70_000);
    const file = temp.file("blob.bin");
    await writeFile(file, body);
    assert.equal(await sha256File(file), sha256Of(body));
    assert.equal(await sizeOf(file), body.length);
    assert.equal(await sizeOf(temp.file("nope.bin")), null);
  } finally {
    await temp.cleanup();
  }
});

test("compareHash：一致与不一致", () => {
  const actual = "b".repeat(64);
  assert.equal(compareHash(actual, actual).ok, true);
  const bad = compareHash("c".repeat(64), actual);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不一致/);
});
