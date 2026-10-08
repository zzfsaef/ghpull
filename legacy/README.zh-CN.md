# 参照实现：上一代的单文件引擎

[English](README.md) · **简体中文**

本目录下的 `dl.mjs` 是 `ghpull` 从中生长出来的**上一代**下载引擎：一个自包含的单文件，
由 `curl.exe` 驱动，启动时一次性规划分块，再用工作窃取队列跑完。保留在这里是作为参照点、
以及对比用的第二个实现；它**不在发布包里**（`package.json` 的 `files` 只列出 `bin/`、`src/`
与文档，所以 `legacy/` 永远不会进入 tarball），也没有接进 CLI。

## 与 `ghpull` 的差异

| | `legacy/dl.mjs` | `ghpull` |
|---|---|---|
| 结构 | 一个 873 行的脚本 | `src/` 分模块，带文档化的 API |
| 传输 | 只用外部 `curl.exe` | 内置 `node:http`/`node:https`，`curl` 作为后备（`--transport auto`） |
| 分块计划 | 启动时固定规划 + 工作窃取队列 | 传输过程中持续切分与再切分 |
| 续传 | 分片文件加 `state.json` | 两层续传：`state.json` 只当线索，以磁盘大小为准 |
| 源选择 | 启动时竞速，之后按块重试 | 逐源测速记录、降级、冷却、竞速预算上限 |
| 启动开销 | 一轮探测，探测失败会让整次运行失败 | 探测带镜像兜底 |
| 测试 | 26 条离线自检（`--self-test`） | 112 条测试（`node --test`），另有负对照脚本 |
| 复用 | 工作区脚本 | 可安装的包（`bin`、`exports`、`files`），零依赖 |

## 用法

```
node legacy/dl.mjs <url> -o <file> [--conns 8] [--mirror <prefix>] [--sha256 <hex>]
node legacy/dl.mjs --self-test      # 26 条离线检查，不联网
```

退出码：`0` 成功、`1` 用法或网络失败、`3` 输出已存在（未加 `--force`）、`4` 摘要不符。

## 一处适配

原文件通过工作区本地的辅助模块解析相对的 `--out` 路径（`import { WS } from "./_paths.mjs"`）。
那个辅助模块没有带进仓库，所以这份副本改成 `const WS = process.cwd()`；对绝对路径、
以及对相对当前目录的路径，行为完全一致。其余内容逐字保留，包括文件头注释里从新引擎
反哺回来的四条加固说明（分片体积对账、严格的 `Content-Range` 校验、合并前逐块长度校验，
以及 `Ctrl-C` 时立即取消）。
