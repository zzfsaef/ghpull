// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { SpeedCalc } from "../src/speed.mjs";
import {
  STATE_VERSION,
  clearParts,
  partFileFor,
  partsDirFor,
  readState,
  stateFileFor,
  writeState,
} from "../src/state.mjs";
import { makeTempDir } from "./helpers.mjs";

/** 每个用例一个临时目录（%TEMP% 下），跑完清理。 */
async function withTemp(fn) {
  const temp = await makeTempDir();
  try {
    await fn(temp);
  } finally {
    await temp.cleanup();
  }
}

/**
 * 直接把内容写进 state.json，绕过 writeState —— 模拟损坏、被外部改动、或被旧版本
 * 写坏的磁盘现场。对象会被序列化，字符串按原样写。
 * @param {string} dest
 * @param {unknown} raw
 */
async function writeRawState(dest, raw) {
  await mkdir(partsDirFor(dest), { recursive: true });
  await writeFile(stateFileFor(dest), typeof raw === "string" ? raw : `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

test("SpeedCalc：环形窗口速率与空闲判定", () => {
  let now = 1_000_000;
  const speed = new SpeedCalc({ windowSec: 4, now: () => now });
  speed.add(1000);
  now += 1000;
  speed.add(1000);
  // 窗口里 2000 字节，已运行 1 秒 ⇒ 2000 B/s
  assert.equal(speed.bps, 2000);
  assert.equal(speed.idleMs, 0);

  now += 5000;
  assert.equal(speed.windowBytes, 0);
  assert.equal(speed.bps, 0);
  assert.equal(speed.idleMs, 5000);
  assert.equal(speed.maxBps, 2000);
});

test("SpeedCalc：开头不用整窗做分母（否则会误判过慢）", () => {
  let now = 0;
  const speed = new SpeedCalc({ windowSec: 10, now: () => now });
  speed.add(5000);
  now += 1000;
  // 分母应是 1 秒而不是 10 秒
  assert.equal(speed.bps, 5000);
});

/** 自洽的基线状态：size 100，两段首尾相接，前段完成、后段只下了 7 字节。 */
const TRUSTED = {
  version: STATE_VERSION,
  url: "https://example.com/a.bin",
  size: 100,
  segments: [
    { start: 0, end: 49, done: 50 },
    { start: 50, end: 99, done: 7 },
  ],
};

/**
 * 可信度矩阵：每一项都必须让 readState 返回 null（上层当作无断点重新规划）。
 * 其中几条是复核实测出来的现场：end 500 / size 100、start "80"、done 999 / 段长 11。
 */
const UNTRUSTED_CASES = [
  { name: "截断的 JSON", raw: () => JSON.stringify(TRUSTED).slice(0, 48) },
  { name: "非法 JSON（{ broken）", raw: () => "{ broken" },
  { name: "version 不匹配（999）", raw: () => ({ ...TRUSTED, version: 999 }) },
  { name: "version 缺失", raw: () => ({ url: TRUSTED.url, size: TRUSTED.size, segments: TRUSTED.segments }) },
  { name: "version 是字符串（\"1\"）", raw: () => ({ ...TRUSTED, version: "1" }) },
  {
    name: "segments 不是数组",
    raw: () => ({ ...TRUSTED, segments: { 0: { start: 0, end: 99, done: 0 } } }),
  },
  { name: "segments 缺失", raw: () => ({ version: STATE_VERSION, url: "u", size: 100 }) },
  {
    name: "segments 里有 null 项",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: 99, done: 0 }, null] }),
  },
  {
    name: "end 越界（end === size）",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: 100, done: 0 }] }),
  },
  {
    name: "end 远超 size（实测现场：size 100 / end 500）",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: 500, done: 0 }] }),
  },
  {
    name: "分段重叠（0-59 与 50-99）",
    raw: () => ({
      ...TRUSTED,
      segments: [
        { start: 0, end: 59, done: 0 },
        { start: 50, end: 99, done: 0 },
      ],
    }),
  },
  {
    name: "分段同 start（完全重复）",
    raw: () => ({
      ...TRUSTED,
      segments: [
        { start: 0, end: 99, done: 0 },
        { start: 0, end: 99, done: 0 },
      ],
    }),
  },
  {
    name: "start 是字符串（\"80\"）",
    raw: () => ({ ...TRUSTED, segments: [{ start: "80", end: 99, done: 0 }] }),
  },
  {
    name: "end 为负",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: -1, done: 0 }] }),
  },
  {
    name: "start 为负",
    raw: () => ({ ...TRUSTED, segments: [{ start: -1, end: 99, done: 0 }] }),
  },
  {
    name: "start > end（负长度）",
    raw: () => ({ ...TRUSTED, segments: [{ start: 80, end: 10, done: 0 }] }),
  },
  {
    name: "done 超过分段长度（实测现场：done 999 / 段长 11）",
    raw: () => ({
      version: STATE_VERSION,
      url: "u",
      size: 100,
      segments: [{ start: 0, end: 10, done: 999 }],
    }),
  },
  {
    name: "done 为负",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: 49, done: -1 }] }),
  },
  {
    name: "done 不是整数（1.5）",
    raw: () => ({ ...TRUSTED, segments: [{ start: 0, end: 49, done: 1.5 }] }),
  },
  { name: "缺 size", raw: () => ({ version: STATE_VERSION, url: "u", segments: TRUSTED.segments }) },
  { name: "size 为负", raw: () => ({ ...TRUSTED, size: -100 }) },
  { name: "size 不是整数（100.5）", raw: () => ({ ...TRUSTED, size: 100.5 }) },
  { name: "size 是字符串（\"100\"）", raw: () => ({ ...TRUSTED, size: "100" }) },
  {
    name: "size > 0 但分段表为空（空计划描述不了任何文件）",
    raw: () => ({ ...TRUSTED, segments: [] }),
  },
  { name: "顶层是数组", raw: () => [] },
  { name: "顶层是 null", raw: () => "null" },
];

for (const item of UNTRUSTED_CASES) {
  test(`state 可信度矩阵：${item.name} ⇒ readState 返回 null`, async () => {
    await withTemp(async (temp) => {
      const dest = temp.file("out.bin");
      await writeRawState(dest, item.raw());
      assert.equal(await readState(dest), null);
    });
  });
}

test("state：自洽的多分段状态原样读回（含部分完成的 done 与额外字段）", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    const state = {
      version: STATE_VERSION,
      url: "https://example.com/a.bin",
      size: 4096,
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2020 07:28:00 GMT",
      sha256: "0".repeat(64),
      updatedAt: "2024-01-01T00:00:00.000Z",
      segments: [
        { start: 0, end: 1023, done: 1024 },
        { start: 1024, end: 2047, done: 0 },
        { start: 2048, end: 4095, done: 333 },
      ],
    };
    await writeState(dest, state);
    const loaded = await readState(dest);
    assert.notEqual(loaded, null);
    // 原样读回：顺序、done、以及所有额外字段都不许被改写
    assert.deepEqual(loaded, state);
    assert.equal(loaded?.segments[0].done, 1024);
    assert.equal(loaded?.segments[1].done, 0);
    assert.equal(loaded?.segments[2].done, 333);
  });
});

test("state：合法边界不被误杀（done=0 / done=整段 / end=size-1 / 首尾相接）", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    const boundary = {
      version: STATE_VERSION,
      url: "u",
      size: 10,
      segments: [
        { start: 0, end: 0, done: 0 }, // 单字节段、未开始
        { start: 1, end: 5, done: 5 }, // 整段完成（done === 长度）
        { start: 6, end: 9, done: 2 }, // 最后一段 end === size - 1
      ],
    };
    await writeState(dest, boundary);
    assert.deepEqual(await readState(dest), boundary);

    // size 0：没有分段也自洽
    const empty = { version: STATE_VERSION, url: "u", size: 0, segments: [] };
    await writeState(dest, empty);
    assert.deepEqual(await readState(dest), empty);
  });
});

test("state：状态文件不存在 / 分片目录被清掉时返回 null", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    assert.equal(await readState(dest), null);

    await writeState(dest, { url: "u", size: 2048, segments: [{ start: 0, end: 2047, done: 0 }] });
    assert.notEqual(await readState(dest), null);
    await clearParts(dest);
    assert.equal(await readState(dest), null);
  });
});

test("partFileFor：分片名只编码 start，切分（end 变小）后仍是同一个文件", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    const a = partFileFor(dest, 0, 1023);
    const b = partFileFor(dest, 0, 2047); // 同 start、不同 end：同一段被切分前后的两种区间
    // 必须是同一个文件：否则切分/重试会换新名字，已经写下的 done 字节留在旧文件里，
    // 新文件从 done 偏移开始追加，成品就缺掉开头 done 个字节。
    assert.equal(a, b);
    assert.equal(path.dirname(a), partsDirFor(dest));
    assert.equal(path.basename(a), "seg-0.part");
    assert.ok(path.isAbsolute(a));

    // 不同 start 才是不同文件（分段表里 start 唯一）
    assert.notEqual(partFileFor(dest, 1024, 2047), partFileFor(dest, 2048, 4095));
  });
});

test("partFileFor：同一区间稳定可重复", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    assert.equal(partFileFor(dest, 4096, 8191), partFileFor(dest, 4096, 8191));
    assert.equal(partFileFor(dest, 4096, 8191), path.join(`${dest}.ghpull`, "seg-4096.part"));
    // 单字节段：start === end
    assert.equal(path.basename(partFileFor(dest, 7, 7)), "seg-7.part");
  });
});

test("partFileFor：拿不到合法区间就抛错，而不是静默生成撞名文件（旧两参数调用不再支持）", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    assert.throws(() => partFileFor(dest, 0), TypeError); // 旧式两参数调用
    assert.throws(() => partFileFor(dest, 0, undefined), TypeError);
    assert.throws(() => partFileFor(dest, 0, 99.5), TypeError);
    assert.throws(() => partFileFor(dest, "0", 99), TypeError);
    assert.throws(() => partFileFor(dest, 10, 9), TypeError); // end < start
    assert.throws(() => partFileFor(dest, -1, 9), TypeError);
    // 合法区间仍然照常返回路径
    assert.equal(path.basename(partFileFor(dest, 0, 99)), "seg-0.part");
  });
});

test("writeState：调用方传 version 也覆盖不了 STATE_VERSION", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    await writeState(dest, {
      version: 999,
      url: "u",
      size: 100,
      segments: [{ start: 0, end: 99, done: 3 }],
    });

    const onDisk = JSON.parse(await readFile(stateFileFor(dest), "utf8"));
    assert.equal(onDisk.version, STATE_VERSION);
    // 版本没被写坏 ⇒ 下次仍能读到断点，而不是整份被丢弃
    const loaded = await readState(dest);
    assert.equal(loaded?.version, STATE_VERSION);
    assert.equal(loaded?.segments[0].done, 3);
  });
});

test("writeState：落盘后同目录不残留 *.tmp", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    const state = { url: "u", size: 2048, segments: [{ start: 0, end: 2047, done: 1024 }] };
    await writeState(dest, state);
    await writeState(dest, { ...state, segments: [{ start: 0, end: 2047, done: 2048 }] }); // 覆盖写第二次

    const entries = await readdir(partsDirFor(dest));
    assert.deepEqual(entries.filter((name) => name.endsWith(".tmp")), []);
    assert.ok(entries.includes("state.json"));
    assert.equal((await readState(dest))?.segments[0].done, 2048);
  });
});

test("writeState：rename 之前失败时旧状态原封不动可用（.tmp 与 rename 目标同目录）", async () => {
  await withTemp(async (temp) => {
    const dest = temp.file("out.bin");
    const good = {
      url: "https://example.com/a.bin",
      size: 2048,
      segments: [{ start: 0, end: 2047, done: 512 }],
    };
    await writeState(dest, good);
    const before = await readFile(stateFileFor(dest), "utf8");

    // 用同名目录占住 .tmp 路径：open(.tmp, "w") 在 Windows 上必失败（EISDIR/EPERM），
    // 失败点正好在 rename 之前。
    const tmpPath = `${stateFileFor(dest)}.tmp`;
    await mkdir(tmpPath);
    await assert.rejects(
      writeState(dest, { ...good, size: 4096, segments: [{ start: 0, end: 4095, done: 0 }] }),
    );

    // 旧状态：字节不变、仍可读、仍是旧分段（没有被半截新状态覆盖，也没被删掉）
    assert.equal(await readFile(stateFileFor(dest), "utf8"), before);
    assert.deepEqual(await readState(dest), { ...good, version: STATE_VERSION });
    // 残留物只有与 rename 目标同目录的 state.json.tmp
    assert.equal(path.dirname(tmpPath), path.dirname(stateFileFor(dest)));
    assert.ok((await readdir(partsDirFor(dest))).includes(path.basename(tmpPath)));
  });
});
