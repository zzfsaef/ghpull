#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * ghpull 的可执行入口。
 *
 * 注意：Windows 上 npm 的 cmd-shim 会读这个文件的第一行 shebang 来决定怎么调它，
 * 所以 `#!/usr/bin/env node` 必须留在第一行，且前面不能有任何 BOM 或空行。
 */

import process from "node:process";

import { main } from "../src/cli.mjs";

// 管道下游提前关掉（`ghpull ... | head`）不该炸出堆栈
process.stdout.on("error", (error) => {
  if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "EPIPE") process.exit(0);
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`ghpull：未预期的错误：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
