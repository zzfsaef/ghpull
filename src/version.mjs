// SPDX-License-Identifier: MIT
/**
 * 版本号：从 package.json 读，避免两处维护。
 *
 * 不用 `import ... with { type: "json" }`：该语法在 Node 18（assert）与
 * Node 22（with）之间不兼容，而 package.json 又是 `exports` 之外的路径。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** User-Agent，服务端与镜像日志里能看出是谁在下载。 */
export const USER_AGENT = `ghpull/${VERSION}`;
