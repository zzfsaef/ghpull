// SPDX-License-Identifier: MIT
/**
 * 语法体检：把仓库里所有 .mjs 文件逐个交给 `node --check` 过一遍。
 *
 * 为什么不用 `node --check` 的 glob：Windows 与 POSIX 的 shell 展开行为不同，
 * 而且 `node --check` 一次只吃一个文件。这里用 Node 自己遍历目录，跨平台一致。
 *
 * 用法：node tools/check-syntax.mjs [目录...]    （默认检查 bin/ src/ test/ tools/）
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRS = ["bin", "src", "test", "tools"];
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** @param {string} dir @param {string[]} out */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const targets = process.argv.slice(2);
const roots = (targets.length > 0 ? targets : DEFAULT_DIRS).map((p) => path.resolve(ROOT, p));

const files = [];
for (const root of roots) {
  try {
    if (statSync(root).isDirectory()) collect(root, files);
  } catch {
    console.error(`跳过不存在的目录：${path.relative(ROOT, root) || "."}`);
  }
}
files.sort();

if (files.length === 0) {
  console.error("没有找到任何 .mjs 文件，检查范围是否写错。");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) {
    console.log(`ok   ${rel}`);
  } else {
    failed += 1;
    console.error(`FAIL ${rel}`);
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    if (detail) console.error(detail.split("\n").map((l) => `     ${l}`).join("\n"));
  }
}

console.log(`\n语法体检：${files.length - failed} 通过 / ${failed} 失败（共 ${files.length} 个文件）`);
process.exit(failed === 0 ? 0 : 1);
