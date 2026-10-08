// SPDX-License-Identifier: MIT
/**
 * 命令行入口：解析参数 → 建引擎 → 跑 → 汇报。
 *
 * 退出码见 errors.mjs 的 EXIT。所有人类可读输出走 stderr，`--json` 的结果走 stdout。
 */

import process from "node:process";

import { HELP, parseCliArgs, readConfigFile } from "./args.mjs";
import { Engine } from "./engine.mjs";
import { EXIT, toGhpullError } from "./errors.mjs";
import { closeAgents } from "./transport.mjs";
import { createReporter, formatResult } from "./ui.mjs";
import { VERSION } from "./version.mjs";

/**
 * 跑一次 CLI。
 * @param {string[]} argv 不含 node 与脚本路径
 * @param {{stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream}} [io]
 * @returns {Promise<number>} 退出码
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  /** @type {import("./args.mjs").CliOptions} */
  let options;
  try {
    options = parseCliArgs(argv);
    if (options.config) {
      // 两遍解析：先拿到 --config，再把配置文件当默认值重跑一遍
      const base = await readConfigFile(options.config);
      options = parseCliArgs(argv, base);
    }
  } catch (error) {
    const gh = toGhpullError(error);
    stderr.write(`ghpull：${gh.message}\n`);
    if (gh.code === EXIT.USAGE) stderr.write("用 `ghpull --help` 查看用法。\n");
    return gh.code ?? EXIT.FAILURE;
  }

  if (options.help) {
    stdout.write(HELP.endsWith("\n") ? HELP : `${HELP}\n`);
    return EXIT.OK;
  }
  if (options.version) {
    stdout.write(`ghpull ${VERSION}\n`);
    return EXIT.OK;
  }

  const reporter = createReporter({
    mode: options.progress,
    stderr,
    stdout,
    verbose: options.verbose,
  });

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const engine = new Engine(
      { ...options, signal: controller.signal },
      { onEvent: (event) => reporter.handle(event) },
    );
    const result = await engine.run();
    if (options.json) {
      stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      reporter.close();
      stderr.write(`${formatResult(result)}\n`);
    }
    return EXIT.OK;
  } catch (error) {
    const gh = toGhpullError(error);
    if (options.json) {
      stdout.write(
        `${JSON.stringify({ ok: false, error: gh.message, code: gh.code ?? EXIT.FAILURE, detail: gh.detail ?? null })}\n`,
      );
    }
    reporter.close();
    if (controller.signal.aborted) {
      stderr.write("ghpull：已中断（分片保留在 .ghpull/，下次用 --continue 接着下）。\n");
      return 130;
    }
    stderr.write(`ghpull：${gh.message}\n`);
    if (gh.detail) stderr.write(`${gh.detail}\n`);
    return gh.code ?? EXIT.FAILURE;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    reporter.close();
    await closeAgents();
  }
}
