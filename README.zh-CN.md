# ghpull

[English](README.md) · **简体中文**

零依赖的 Node.js 命令行工具，用于在慢速或不稳定的链路上拉取单个大文件（GitHub 发布包、ISO 镜像、压缩包）：并发 HTTP Range 分段请求、多源择优、两层续传、停滞看门狗与内建 SHA-256 校验——`npx` 直接可用，不下载任何二进制，也不依赖外部下载器。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zzfsaef/ghpull/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/badge/npm-ghpull-cb3837.svg)](https://www.npmjs.com/package/ghpull)
[![Runtime dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#features)

## 特性

- **零运行时依赖。**`dependencies` 与 `devDependencies` 都是空对象，只用 Node.js 标准库；安装时不下载任何东西。
- **不需要任何二进制。**不捆绑 `aria2c`/`axel`，不需要编译，在装好 Node.js 的机器上 `npx ghpull <url>` 即可运行。
- **并发分段传输。**把文件切成多个分段，以并行的 HTTP Range 请求拉取；运行中还会按中点继续切分分段。
- **两层续传。**中断后留下的分片目录会被下一次运行复用；已经下载完成、大小与远端一致的文件也会被直接接受，不会重下。
- **停滞看门狗。**任何停止产出新字节的连接都会被中断并放回队列，单条卡死的连接不会拖住整个传输。
- **内建 SHA-256 校验。**给出 `--sha256` 后，摘要会在合并分片的过程中同步计算，并在文件落位前完成比对。
- **原子落位与覆盖保护。**结果先写到目标旁边再改名落位；已存在的文件绝不会被悄悄覆盖。
- **真实的进度输出。**`auto`、`plain`、`none`、`json`（NDJSON）四种模式，既能保持交互终端可读，也能让 CI 日志与管道保持干净。
- **可选的多来源。**可以用 `--mirror` 追加来源；内置的第三方镜像清单纯在，但**默认关闭**（见[第三方来源与镜像](#第三方来源与镜像)）。

## 环境要求

- **Node.js >= 18**（见 `package.json` 的 `engines.node`）。可在 Windows、macOS、Linux 上运行（`os`：`win32`、`darwin`、`linux`）；CI 目前只覆盖 Windows 与 Linux，因为本仓库的 `macos-latest` runner 一直排队排不出来。
- 如果通过 npm 或 `npx` 使用，需要 `npm`（随 Node.js 一起安装）。直接从仓库运行则不需要任何安装步骤。
- **curl 是可选的。**只有在 Node.js 不信任站点 TLS 证书时，才会作为备用传输层使用——见[工作原理](#工作原理)。

## 安装

用 `npx` 的话不需要安装：

```bash
npx ghpull --help
```

也可以全局安装：

```bash
npm install -g ghpull
```

从克隆的仓库运行：

```bash
git clone https://github.com/zzfsaef/ghpull.git
cd ghpull
node bin/ghpull.mjs --help
```

## 快速开始

```bash
# 下载一个文件；文件名取自 Content-Disposition 或 URL
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file>

# 指定输出路径并校验摘要
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  -o app.zip --sha256 <64位十六进制>

# 续传上一次被中断的下载
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o app.zip --continue
```

所有人类可读输出都走 **stderr**；stdout 上只有 `--json` 的结果，因此 `ghpull ... | jq` 不会被进度信息污染。

## 常用示例

**1. 自定义并发与超时**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  --conns 8 --max-conns 16 --timeout 30 --stall-sec 12
```

`--conns` 是起始连接数，`--max-conns` 是自适应增长的上限，`--stall-sec` 决定一条安静的连接可以安静多久才被换掉。

**2. 按发布方公布的摘要校验产物**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  -o <file> --sha256 sha256:<64位十六进制>
```

摘要不一致时以退出码 `4` 结束，并保留分片以便重试。见[退出码](#退出码)。

**3. 追加一个你自己信任的镜像**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  --mirror "https://mirror.example.com/{url}" --mirror-mode manual
```

模板必须包含 `{url}` 占位符。`--mirror-mode manual` 只用你给出的模板；`--mirror-mode auto` 会在其之上叠加内置的第三方清单。只写 `--mirror` 而不给 `--mirror-mode manual` 或 `auto` 是不生效的，因为默认模式是 `off`。

**4. 给脚本用的机器可读输出**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> --json | jq -r .sha256
```

`--json` 等价于 `--progress json` 再加上 stdout 上的一条最终结果对象。

**5. 从头重下，或保留分片**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o <file> --force
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o <file> --continue --keep-parts
```

`--force` 会删除已存在的目标文件及其分片并重下；`--keep-parts` 在成功结束后仍保留分片目录（排查问题时有用）。

## 选项表

下表每个选项都定义在 `src/args.mjs`（`OPTION_TABLE` 加上 `parseCliArgs` 施加的默认值）。尺寸接受可选单位后缀：`B`、`K`/`KiB`、`M`/`MiB`、`G`/`GiB`、`T`/`TiB`（均为 1024 进制）；结尾的 `/s` 会被忽略，因此 `1MiB/s` 按 `1MiB` 解析。

### 输出与断点

| 长选项 | 短选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `--out` | `-o` | 路径 | 取自 `Content-Disposition`，否则取 URL 末段（兜底 `download.bin`） | 输出文件路径。 |
| `--force` | — | 开关 | 关 | 删除已存在的目标与分片，从头下载。与 `--continue` 互斥。 |
| `--continue` | — | 开关 | 关 | 目标已存在时继续或校验，而不是拒绝。与 `--force` 互斥。 |
| `--no-resume` | — | 开关 | 关（续传**默认开启**） | 丢弃已有断点重新开始，但不删除目标文件。 |
| `--keep-parts` | — | 开关 | 关 | 成功结束后保留分片目录。 |

### 并发、超时与看门狗

| 长选项 | 短选项 | 类型 | 默认值 | 取值范围 |
| --- | --- | --- | --- | --- |
| `--conns` | — | 整数 | `8` | 1–64 |
| `--max-conns` | — | 整数 | `16` | 1–128；必须 `>= --conns` |
| `--min-split` | — | 尺寸 | `8MiB` | 至少 `64KiB` |
| `--timeout` | — | 秒 | `30` | 1–3600（单次请求） |
| `--stall-sec` | — | 秒 | `12` | 3–3600（多久没有新字节即判为停滞） |
| `--lowest-speed` | — | 速率 | `1KiB/s`（`1024` 字节/秒） | 必须是正的尺寸值 |
| `--retries` | — | 整数 | `5` | 0–50（每个分段的重试次数） |

### 来源与传输层

| 长选项 | 短选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `--mirror` | — | 模板 | 无 | 追加的镜像模板；必须含 `{url}`；可重复。 |
| `--mirror-mode` | — | 枚举 | `off` | `off` \| `manual` \| `auto`。`off` 只用原始 URL；`manual` 只用 `--mirror` 给的模板（至少一个）；`auto` 额外启用内置的第三方清单。 |
| `--transport` | — | 枚举 | `auto` | `auto` \| `node` \| `curl`。`auto` 先用 Node.js，遇到 TLS 证书类错误时改用 curl。 |
| `--curl-path` | — | 路径 | 未设置（自动探测：先 `--curl-path`，再 `$GHPULL_CURL`，最后 `PATH` 上的 `curl.exe`/`curl`） | 显式指定 curl 可执行文件。 |
| `--config` | — | 路径 | 未设置 | JSON 配置文件，其中的键作为默认值（见[配置文件](#配置文件)）。 |

### 校验与输出

| 长选项 | 短选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `--sha256` | — | 哈希 | 未设置（不校验摘要） | 期望的 SHA-256；64 位十六进制，可带 `sha256:` 前缀。 |
| `--progress` | — | 枚举 | `auto` | `auto`（TTY 上单行刷新，否则每秒一行）\| `plain` \| `none` \| `json`（stdout 上的 NDJSON）。 |
| `--json` | — | 开关 | 关 | 在 stdout 上输出 JSON 结果摘要；等价于 `--progress none` 加摘要，并覆盖 `--progress`。 |
| `--verbose` | `-v` | 开关 | 关 | 打印诊断信息（探测结果、来源竞速、分段计划、失败详情）。 |
| `--help` | `-h` | 开关 | 关 | 显示帮助并以 `0` 退出。 |
| `--version` | `-V` | 开关 | 关 | 打印版本并以 `0` 退出。 |

位置参数只接受一个 URL；给出第二个即为用法错误。

## 退出码

退出码属于公共接口（见 `src/errors.mjs`）。

| 退出码 | 含义 | 常见原因 |
| --- | --- | --- |
| `0` | 成功 | 文件已下载、校验并落位。 |
| `1` | 失败 | 网络、磁盘或 TLS 错误；某个分段用尽 `--retries`；被 `SIGINT`/`SIGTERM` 中断（这种情形实际报 `130`，见下）。 |
| `2` | 用法错误 | 未知选项、取值非法、缺少 URL、给了多个 URL、`--force` 与 `--continue` 同时出现、`--max-conns` 小于 `--conns`、配置文件读不到或不是合法 JSON。 |
| `3` | 目标已存在 | 输出文件已存在，且既没给 `--force` 也没给 `--continue`。 |
| `4` | 校验失败 | 计算出的 SHA-256 与 `--sha256` 不一致。 |
| `5` | 目标不支持 | 服务器不支持 Range 且无法降级，或 URL 协议不是 `http`/`https`。 |
| `6` | 所有来源不可用 | 每一个候选来源都失败了。 |
| `130` | 已中断 | 收到 `SIGINT`/`SIGTERM`；分片会保留，用 `--continue` 可接着下。该退出码来自 `src/cli.mjs`，不在 `EXIT` 表里。 |

## 配置文件

`--config <文件>` 指向一个 JSON 文件，顶层必须是对象。其中的键都是**默认值**：命令行显式给出的值优先。键名与命令行选项略有差异，读取位置在 `parseCliArgs`：

| 配置键 | 对应选项 | 类型 |
| --- | --- | --- |
| `mirrors` | `--mirror`（可重复） | 字符串数组 |
| `mirrorMode` | `--mirror-mode` | `"off"` \| `"manual"` \| `"auto"` |
| `conns` | `--conns` | 数字或字符串 |
| `maxConns` | `--max-conns` | 数字或字符串 |
| `minSplit` | `--min-split` | 数字（字节）或尺寸字符串 |
| `timeoutSec` | `--timeout` | 数字或字符串 |
| `stallSec` | `--stall-sec` | 数字或字符串 |
| `lowestSpeed` | `--lowest-speed` | 数字（字节/秒）或尺寸字符串 |
| `retries` | `--retries` | 数字或字符串 |
| `transport` | `--transport` | `"auto"` \| `"node"` \| `"curl"` |
| `curlPath` | `--curl-path` | 字符串 |
| `progress` | `--progress` | `"auto"` \| `"plain"` \| `"none"` \| `"json"` |

示例：

```json
{
  "conns": 8,
  "maxConns": 16,
  "minSplit": "8MiB",
  "timeoutSec": 30,
  "stallSec": 12,
  "lowestSpeed": "1KiB",
  "retries": 5,
  "mirrorMode": "manual",
  "mirrors": ["https://mirror.example.com/{url}"]
}
```

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> --config ./ghpull.json
```

说明：

- 只读取上表中的键。`--out`、`--sha256`、`--force`、`--continue`、`--no-resume`、`--keep-parts`、`--json` 没有对应的配置键。
- 取值走与命令行相同的解析器，取值范围与互斥规则同样适用。
- 文件不存在或不是合法 JSON 都算用法错误（退出码 `2`）。

## 工作原理

**探测。**先用 `HEAD`（必要时退化为带 `Range: bytes=0-0` 的 `GET`）获取文件大小、是否支持分段、跟随重定向（最多 5 跳）后的最终 URL 以及文件名。每个请求都显式发送 `Accept-Encoding: identity`，避免服务端压缩打乱字节偏移；`User-Agent` 为 `ghpull/<版本>`。

**分段。**支持 Range 时，文件被切成若干分段，每段用独立的 `Range` 请求拉取，初始段数为 `min(conns, floor(size / (2 × min-split)))`。仍然大于两倍 `--min-split` 的分段会在其**尚未下载区域**的中点被切开，这样已经落盘的字节依旧合法。收尾阶段（剩余量降到 `max(2 × min-split, 4MiB)` 以下）切分阈值放宽到 `max(256KiB, min-split / 8)`、上限提高到 `--max-conns`，避免最后几兆由单条连接慢慢搬完。

**续传。**进度存放在 `<输出文件>.ghpull/`：`state.json` 记录分段表（起始、结束、已完成字节）以及 URL 与大小；`seg-<起始偏移>.part` 存放数据。分片按**起始偏移**而非序号命名，因为分段会在运行中被切开。状态每隔几秒以原子方式重写（先写临时文件再改名）。下一次运行时，只有大小仍然一致、且 URL 与原始 URL 或最终 URL 相符，才会使用该状态；每个分片还会按期望长度重新核对，被截断或超长的分片会被丢弃并重下。因此续传有两个层面：未完成运行的分片，以及大小已与远端一致、已经下完的输出文件。

**看门狗与并发。**引擎每 250 毫秒检查一次连接是否在产出字节。超过 `--stall-sec` 没有新字节、或 10 秒后均速低于 `--lowest-speed` 的分段会被中断并放回队列；出错的来源进入 30 秒冷却，分段随后重试（最多 `--retries` 次，超过即以退出码 `6` 失败）。吞吐每 6 秒采样一次，速率改善至少 5% 时连接目标加 2，否则减 2，范围限定在 `1` 与 `--max-conns` 之间。

**校验与落位。**所有分段完成后，按顺序把分片合并到 `<输出文件>.ghpull-merge`，同时流式计算 SHA-256 摘要（不会二次回读文件）。分段边界必须连续且总长恰好等于声明的大小。若给了 `--sha256` 而摘要不一致，合并结果被丢弃、分片保留、进程以退出码 `4` 结束。否则删除已存在的目标文件，把合并结果改名落位，并在未指定 `--keep-parts` 时删除分片目录。

**单流兜底。**如果服务器不支持 Range（或对 Range 请求返回 `206` 以外的状态），ghpull 退化为带看门狗的单次 `GET`，计算摘要后落位。这种传输无法分段也无法续传，结果摘要里会注明（`mode: "single-stream"`）。

**空目标与不支持的协议。**大小为 0 的资源会生成一个空文件；若给了 `--sha256` 则一并校验。非 `http(s)` 协议以退出码 `5` 结束。

**来源选择。**候选来源包括原始 URL 与展开后的镜像模板。候选多于一个时，每个候选先实抓 256 KiB 测出真实吞吐，只保留不慢于最快源 50% 的那些。此后每个来源维护一份指数加权速率记录，并以 20 KiB/s 作为门槛参与打分；分段优先选择分数最高、且不在冷却期的来源。

**两条传输层。**`node` 使用内置 `node:http`/`node:https`，配合 `maxSockets` 受 `--max-conns` 约束的 keep-alive agent。`curl` 调用系统 `curl` 并读取其 stdout，适用于 Node.js 不信任当前系统的 CA 链（企业代理、自签中间人）而报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 的环境；`auto`（默认）先用 Node.js，遇到这类 TLS 错误时切换到 curl，若找不到可用的 curl 则给出明确报错。返回 `206` 时，只有 `Content-Range` 与请求区间完全一致才会被接受。

## 第三方来源与镜像

- **默认不使用任何第三方代理或镜像。**`--mirror-mode` 默认为 `off`，所以直接执行 `npx ghpull <url>` 时，只与你给出的 URL 所在主机通信。
- **内置镜像清单默认关闭，只有显式开启才会使用。**清单里是几个公开的第三方 GitHub 代理服务，仅在 `--mirror-mode auto` 时才会被考虑。这些服务由志愿者运营，与本项目没有隶属关系，其可用性、行为与合法性都需要你自行判断。
- **本项目不提供、不托管、不运营、也不背书任何代理或镜像服务。**`--mirror` 与 `--mirror-mode` 只是告诉 ghpull 还可以尝试哪些 URL；是否使用以及由此产生的后果由你承担。
- **分片混用的风险。**镜像与原始源必须为同一偏移提供**相同的字节**。如果你把镜像指向了另一个对象，合并出来的文件会是两者的混合体——只要下载的内容不完全由你掌控，就请配合 `--sha256` 使用。

## 与 aria2、axel、wget2、hget 的定位差异

这些都是成熟且被广泛使用的多协议下载器，本项目并不打算取代它们。下面是 GitHub 上的大致星数（2026-10-08 查询，仅用于量级参考）：[aria2](https://github.com/aria2/aria2) 约 4.3 万、[axel](https://github.com/axel-download-accelerator/axel) 约 3.4 千、[hget](https://github.com/huydx/hget) 约 1 千、[wget2](https://github.com/rockdaboot/wget2) 约 0.8 千。

| | ghpull | aria2 | axel | wget2 | hget |
| --- | --- | --- | --- | --- | --- |
| 运行环境 | 已装好的 Node.js >= 18 | 原生二进制 | 原生二进制 | 原生二进制 | Go 二进制 |
| 安装方式 | `npx ghpull`（无需下载任何东西） | 包管理器或发布二进制 | 包管理器或发布二进制 | 包管理器或源码构建 | go install 或发布二进制 |
| 运行时依赖 | 无 | 系统库 | 系统库 | 系统库 | 无 |
| 协议 | HTTP/HTTPS | HTTP/HTTPS、FTP、SFTP、BitTorrent、Metalink | HTTP/HTTPS、FTP | HTTP/HTTPS、FTP 等 | HTTP/HTTPS |
| 分段 / 多源 | 支持 | 支持（可调项远多于本项目） | 支持 | 有限 | 支持 |
| 续传 | 支持，两层 | 支持 | 支持 | 支持 | 支持 |
| SHA-256 校验 | 内建 | 通过 `--check-integrity` | 无 | 无 | 无 |
| BitTorrent / RPC / 浏览器集成 | 无 | 有 | 无 | 无 | 无 |
| 定位 | Node.js 环境里的单文件下载 | 通用下载引擎 | 命令行下载工具 | 递归镜像与抓取 | 命令行下载工具 |

本项目的取舍是：留在「已经装好 Node.js >= 18、`npx ghpull` 立刻可用」的环境里，不落任何原生二进制、不带依赖树，并且只做一件事——用分段请求、可续传状态和摘要校验拉取单个 HTTP(S) 文件。如果你需要 BitTorrent、Metalink、FTP/SFTP、RPC 接口，或者多年积累的协议边界处理，请使用 aria2 或 wget2；如果想要不依赖 Node.js 运行时的下载工具，请使用 axel 或 hget。

### `legacy/` 里的上一代引擎

`ghpull` 从一个单文件下载器长出来（那份代码原先放在工作区的 `scripts/dl.mjs`）。这里保留了它作为**参照实现**和对比用的第二个数据点：[`legacy/dl.mjs`](legacy/dl.mjs)。它靠 `curl.exe` 传输、启动时一次性规划分块，自带 26 条离线自检；它**不在发布包里**，也没有接进 CLI。两者的差异列在 [`legacy/README.md`](legacy/README.md)。

## 常见问题

**ghpull 会让下载变快吗？**
它会发出并发的 HTTP Range 请求、在多个来源之间择优，并重试停滞的连接。是否有帮助完全取决于服务端、链路与文件本身：很多站点限制单连接吞吐（这时分段有意义），也有一些已经跑满你的带宽或对总速率做限制（这时分段没有意义）。本项目不承诺任何速度提升，文档中也不出现任何倍速说法。

**需要先装 aria2 或 curl 吗？**
不需要，只需要 Node.js >= 18。curl 是可选的，仅在作为 TLS 备用传输层时才会用到。

**支持哪些 URL？**
任何 `http`/`https` URL——实践中常见的是直链文件，例如 `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`。HTML 页面同样只是文件；ghpull 不会解析页面或跟随其中的链接，也不做递归下载与批量下载。

**Node 报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 怎么办？**
这说明 Node.js 不信任该证书链（常见于做 TLS 拦截的企业代理）。`auto` 传输层会识别这类错误并改用系统 `curl`，后者使用操作系统的信任库。你也可以用 `NODE_EXTRA_CA_CERTS` 指向代理的 CA，或用 `--transport curl` / `--transport node` 强制指定传输层。证书校验在任何情况下都不会被关闭。

**下载被中断了，要重头开始吗？**
不用。用同样的命令加上 `--continue` 再跑一次即可（其实直接重跑也行：ghpull 能认出自己的分片目录）。已经落盘的字节会被复用，结果摘要里以 `reusedBytes` 报告。

**下载文件旁边出现了 `<文件名>.ghpull/` 目录，是什么？**
那是分片目录：`state.json` 加上每个分段一个 `seg-<起始偏移>.part`。成功结束后它会自动消失，除非你加了 `--keep-parts`。校验失败时它会被有意保留，以免下次只能盲目重下。

**可以同时跑多个下载吗？**
可以——多个进程、各自不同的输出路径即可。每个下载维护自己的分片目录，状态文件以原子方式写入。

**不给 `--sha256` 就没有任何校验吗？**
会做内部一致性校验（每个分段连续、总长度等于声明大小），并在结果摘要里给出实际计算出的 SHA-256；但摘要比对只在你给出期望值时进行。绝不会凭空造出一个「校验通过」。

**脚本里怎么拿到结果？**
`--json` 会在 stdout 上输出 NDJSON 进度事件和一条最终结果对象（含 `ok`、`out`、`bytes`、`elapsedSec`、`avgBps`、`reusedBytes`、`fetchedBytes`、`fetchBps`、`peakConns`、`sources`、`transport`、`sha256`，兜底单流时还有 `mode: "single-stream"`）。所有人类可读输出都留在 stderr。

**为什么不用 curl / Invoke-WebRequest 直接下？**
文件小的话就这样做。这个工具面向的是「链路会掉、会卡」场景下的大文件单个下载——这时续传、看门狗与摘要校验比一行命令更重要。

## 免责声明

本程序不提供任何担保，使用风险由你自己承担。

- ghpull 只是一个客户端工具。它从你给出的 URL 下载，自身不提供、不托管、不运营任何代理、镜像或内容服务。
- 第三方来源——包括你自行配置的镜像，以及在你开启后才会用到的内置清单中的服务——都不在本项目的控制范围内。在依赖它们之前，其可用性、速度、内容完整性与合法性都需要你自己判断。
- 你需要自行遵守所访问站点的服务条款、robots 与限速策略，以及你所在地区的法律。未经许可下载受版权保护的内容可能违法。
- 本项目不提供任何明示或默示的担保，包括可商用性、特定用途适用性与不侵权担保。作者与贡献者不对使用本软件所造成的任何损失承担责任。

## 许可

[MIT](https://github.com/zzfsaef/ghpull/blob/main/LICENSE) © ghpull contributors。

欢迎贡献——见 [CONTRIBUTING.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.zh-CN.md)（英文原文为 [CONTRIBUTING.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.md)）。如需上报安全漏洞，请按 [SECURITY.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.zh-CN.md) 所述使用[私密上报](https://github.com/zzfsaef/ghpull/security/advisories/new)；请不要为安全问题开公开 issue。

面向读者的文档都提供中英两份：本文件与 [README.md](https://github.com/zzfsaef/ghpull/blob/main/README.md)、[CONTRIBUTING.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.zh-CN.md) / [CONTRIBUTING.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.md)、[SECURITY.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.zh-CN.md) / [SECURITY.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.md)，以及 [`legacy/`](https://github.com/zzfsaef/ghpull/tree/main/legacy) 下的文件。
