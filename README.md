# ghpull

**English** · [简体中文](README.zh-CN.md)

A zero-dependency Node.js CLI for pulling large single files (GitHub release assets, ISO images, tarballs) over slow or flaky links: concurrent HTTP Range requests, multi-source selection, two-layer resume, a stall watchdog and built-in SHA-256 verification — installable with `npx`, with no binary to download and no external downloader required.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zzfsaef/ghpull/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/badge/npm-ghpull-cb3837.svg)](https://www.npmjs.com/package/ghpull)
[![Runtime dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#features)

## Features

- **Zero runtime dependencies.** `dependencies` and `devDependencies` are both empty; only the Node.js standard library is used. Nothing is downloaded at install time.
- **No binary required.** There is no bundled `aria2c`/`axel` helper and nothing to compile. `npx ghpull <url>` runs on a plain Node.js installation.
- **Concurrent segmented transfer.** The file is split into segments fetched as parallel HTTP Range requests; segments are re-split at the midpoint while the download is running.
- **Two-layer resume.** An interrupted run leaves a parts directory behind, so the next run reuses the bytes already on disk — and a finished file whose size already matches the remote object is accepted without re-downloading.
- **Stall watchdog.** Any segment that stops producing new bytes is aborted and re-queued, so a single hung connection does not stall the whole transfer.
- **Built-in SHA-256 verification.** Pass `--sha256` and the digest is computed while the parts are merged, then compared before the file is moved into place.
- **Atomic placement and overwrite protection.** The result is written next to the destination and renamed into place; an existing file is never silently overwritten.
- **Real progress reporting.** `auto`, `plain`, `none` and `json` (NDJSON) modes keep interactive terminals readable and CI logs and pipelines clean.
- **Optional multi-source.** Extra sources can be supplied with `--mirror`, and a built-in list of third-party mirrors exists but is **off by default** (see [Third-party sources](#third-party-sources-and-mirrors)).

## Requirements

- **Node.js >= 18** (`engines.node` in `package.json`). Runs on Windows, macOS and Linux (`os`: `win32`, `darwin`, `linux`); CI currently covers Windows and Linux only, because `macos-latest` runners stayed queued indefinitely on this repository.
- `npm` (bundled with Node.js) if you install through npm or `npx`. The repository itself needs no installation step to run.
- **curl is optional.** It is only used as a fallback transport when Node.js does not trust a site's TLS certificate — see [How it works](#how-it-works).

## Installation

There is nothing to install if you use `npx`:

```bash
npx ghpull --help
```

Or install it globally:

```bash
npm install -g ghpull
```

From a clone:

```bash
git clone https://github.com/zzfsaef/ghpull.git
cd ghpull
node bin/ghpull.mjs --help
```

## Quick start

```bash
# Download a file; the name is taken from Content-Disposition or the URL
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file>

# Choose the output path and verify the digest
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  -o app.zip --sha256 <64-hex-digits>

# Resume an interrupted download
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o app.zip --continue
```

All human-readable output goes to **stderr**; stdout carries only the `--json` result, so `ghpull ... | jq` stays clean.

## Usage examples

**1. Pick your own concurrency and timeouts**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  --conns 8 --max-conns 16 --timeout 30 --stall-sec 12
```

`--conns` is the starting number of connections, `--max-conns` caps the adaptive growth, and `--stall-sec` decides how long a silent connection may stay silent before it is dropped.

**2. Verify a release asset against its published digest**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  -o <file> --sha256 sha256:<64-hex-digits>
```

A mismatch exits with code `4` and keeps the parts so you can retry. See [Exit codes](#exit-codes).

**3. Add an explicit mirror you trust**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> \
  --mirror "https://mirror.example.com/{url}" --mirror-mode manual
```

The template must contain the `{url}` placeholder. `--mirror-mode manual` uses only the templates you passed; `--mirror-mode auto` adds the built-in third-party list on top of them. A plain `--mirror` without `--mirror-mode manual` or `auto` has no effect, because the default mode is `off`.

**4. Machine-readable progress for a script**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> --json | jq -r .sha256
```

`--json` is equivalent to `--progress json` plus a final result object on stdout.

**5. Re-download from scratch, or keep the parts**

```bash
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o <file> --force
npx ghpull https://github.com/<owner>/<repo>/releases/download/<tag>/<file> -o <file> --continue --keep-parts
```

`--force` deletes the existing destination and its parts and starts over; `--keep-parts` keeps the `.<parts>` directory after a successful run (useful for debugging).

## Options

Every option below is defined in `src/args.mjs` (`OPTION_TABLE` plus the defaults applied by `parseCliArgs`). Sizes accept an optional unit suffix: `B`, `K`/`KiB`, `M`/`MiB`, `G`/`GiB`, `T`/`TiB` (all powers of 1024); a trailing `/s` is ignored, so `1MiB/s` parses as `1MiB`.

### Output and resume

| Long | Short | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `--out` | `-o` | path | derived from `Content-Disposition`, else the last URL path segment (falling back to `download.bin`) | Output file path. |
| `--force` | — | flag | off | Delete an existing destination and its parts, then download from scratch. Mutually exclusive with `--continue`. |
| `--continue` | — | flag | off | Continue or verify an existing destination instead of refusing. Mutually exclusive with `--force`. |
| `--no-resume` | — | flag | off (resume is **on** by default) | Discard existing part state and start over without deleting the destination file. |
| `--keep-parts` | — | flag | off | Keep the parts directory after a successful download. |

### Concurrency, timeouts and watchdogs

| Long | Short | Type | Default | Allowed range |
| --- | --- | --- | --- | --- |
| `--conns` | — | integer | `8` | 1–64 |
| `--max-conns` | — | integer | `16` | 1–128; must be `>= --conns` |
| `--min-split` | — | size | `8MiB` | at least `64KiB` |
| `--timeout` | — | seconds | `30` | 1–3600 (per request) |
| `--stall-sec` | — | seconds | `12` | 3–3600 (no new bytes → treat as stalled) |
| `--lowest-speed` | — | rate | `1KiB/s` (`1024` B/s) | must be a positive size |
| `--retries` | — | integer | `5` | 0–50 (attempts per segment) |

### Sources and transport

| Long | Short | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `--mirror` | — | template | none | Extra mirror template; must contain `{url}`; repeatable. |
| `--mirror-mode` | — | enum | `off` | `off` \| `manual` \| `auto`. `off` uses only the original URL; `manual` uses only your `--mirror` templates (at least one required); `auto` additionally enables the built-in third-party list. |
| `--transport` | — | enum | `auto` | `auto` \| `node` \| `curl`. `auto` starts with Node.js and falls back to curl on TLS certificate errors. |
| `--curl-path` | — | path | unset (auto-detected: `--curl-path`, then `$GHPULL_CURL`, then `curl.exe`/`curl` on `PATH`) | Explicit curl executable. |
| `--config` | — | path | unset | JSON config file whose keys act as defaults (see [Configuration file](#configuration-file)). |

### Verification and output

| Long | Short | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `--sha256` | — | hex | unset (no digest check) | Expected SHA-256; 64 hex digits, optionally prefixed with `sha256:`. |
| `--progress` | — | enum | `auto` | `auto` (single-line refresh on a TTY, one line per second otherwise) \| `plain` \| `none` \| `json` (NDJSON on stdout). |
| `--json` | — | flag | off | Print a JSON result summary on stdout; equivalent to `--progress none` plus the summary. Overrides `--progress`. |
| `--verbose` | `-v` | flag | off | Print diagnostics (probe result, source race, segment plan, failures). |
| `--help` | `-h` | flag | off | Show help and exit `0`. |
| `--version` | `-V` | flag | off | Print the version and exit `0`. |

Exactly one URL positional argument is accepted; a second one is a usage error.

## Exit codes

Exit codes are part of the public interface (`src/errors.mjs`).

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `0` | Success | The file was downloaded, verified and placed. |
| `1` | Failure | Network, disk or TLS error; a segment exhausted `--retries`; the run was interrupted by `SIGINT`/`SIGTERM` (this last case reports `130`, see below). |
| `2` | Usage error | Unknown option, bad value, missing URL, more than one URL, `--force` with `--continue`, `--max-conns` below `--conns`, unreadable or invalid config file. |
| `3` | Destination exists | The output file exists and neither `--force` nor `--continue` was given. |
| `4` | Checksum mismatch | The computed SHA-256 differs from `--sha256`. |
| `5` | Unsupported target | The server does not support Range requests and no downgrade was possible, or the URL scheme is not `http`/`https`. |
| `6` | No usable source | Every candidate source failed. |
| `130` | Interrupted | `SIGINT`/`SIGTERM` was received; parts are kept, so `--continue` resumes. This code comes from `src/cli.mjs`, not from the `EXIT` table. |

## Configuration file

`--config <file>` points at a JSON file whose top-level value is an object. Its keys are **defaults**: anything given on the command line wins. Key names differ slightly from the CLI flags and are read in `parseCliArgs`:

| Config key | CLI equivalent | Type |
| --- | --- | --- |
| `mirrors` | `--mirror` (repeatable) | array of strings |
| `mirrorMode` | `--mirror-mode` | `"off"` \| `"manual"` \| `"auto"` |
| `conns` | `--conns` | number or string |
| `maxConns` | `--max-conns` | number or string |
| `minSplit` | `--min-split` | number (bytes) or size string |
| `timeoutSec` | `--timeout` | number or string |
| `stallSec` | `--stall-sec` | number or string |
| `lowestSpeed` | `--lowest-speed` | number (bytes/s) or size string |
| `retries` | `--retries` | number or string |
| `transport` | `--transport` | `"auto"` \| `"node"` \| `"curl"` |
| `curlPath` | `--curl-path` | string |
| `progress` | `--progress` | `"auto"` \| `"plain"` \| `"none"` \| `"json"` |

Example:

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

Notes:

- Only the keys above are read. `--out`, `--sha256`, `--force`, `--continue`, `--no-resume`, `--keep-parts` and `--json` have no config equivalent.
- Values are validated with the same parsers as the CLI, and the same ranges and mutual-exclusion rules apply.
- A missing file or invalid JSON is a usage error (exit `2`).

## How it works

**Probe.** The tool sends a `HEAD` request (falling back to `GET` with `Range: bytes=0-0`) to learn the size, whether the server supports ranges, the final URL after redirects (up to 5) and a filename. Every request sends `Accept-Encoding: identity` so that server-side compression cannot shift byte offsets, and `User-Agent: ghpull/<version>`.

**Segmentation.** With ranges supported, the file is split into segments — each fetched as its own `Range` request — up to `min(conns, floor(size / (2 × min-split)))`. A segment that is still larger than twice `--min-split` is split at the midpoint of its *not-yet-downloaded* region, so bytes already on disk stay valid. In the closing phase, when the remaining work drops to `max(2 × min-split, 4MiB)`, the split threshold is lowered to `max(256KiB, min-split / 8)` and the ceiling rises to `--max-conns`, which keeps the last few megabytes from being carried by a single connection.

**Resume.** Progress lives in `<output>.ghpull/`: `state.json` holds the segment table (offset, end, bytes done) plus the URL and size, and `seg-<start>.part` files hold the payload, named by their starting offset rather than a sequence number because segments get split while running. The state is rewritten atomically (temp file plus rename) every few seconds. On the next run the state is used only if the size still matches and the URL matches the original or the final URL; each part file is re-checked against its expected length, and a truncated or oversized part is discarded and re-fetched. Resume is therefore available at two levels: the parts of an unfinished run, and a finished output file whose size already equals the remote object.

**Watchdog and concurrency.** Every 250 ms the engine checks whether a connection is producing bytes. A segment with no new bytes for `--stall-sec`, or an average below `--lowest-speed` after 10 seconds, is aborted and re-queued; the source that failed is put on a 30-second cooldown and the segment is retried (up to `--retries`, after which the run fails with exit `6`). Throughput is sampled every 6 seconds and the connection target moves by ±2 depending on whether the rate improved by at least 5%, bounded by `1` and `--max-conns`.

**Verification and placement.** When all segments are done, the parts are merged in order into `<output>.ghpull-merge` while the SHA-256 digest is computed on the fly (the file is not read a second time). Segment boundaries must be contiguous and cover exactly the announced size. If `--sha256` was given and the digest differs, the merge is discarded, the parts are kept, and the run exits `4`. Otherwise the existing destination is removed, the merged file is renamed into place, and the parts directory is deleted unless `--keep-parts` was given.

**Single-stream fallback.** If the server does not support ranges (or answers a range request with something other than `206`), ghpull falls back to a single `GET` with a watchdog, computes the digest, and places the file. Such a transfer cannot be segmented or resumed, and the summary says so (`mode: "single-stream"`).

**Empty and unsupported targets.** A zero-length resource produces an empty file, verified against `--sha256` when one was given. A non-`http(s)` scheme exits `5`.

**Source selection.** Candidate sources are the original URL plus any expanded mirror templates. When more than one exists, each candidate fetches 256 KiB to measure real throughput, and only candidates within 50% of the fastest are kept. Afterwards each source keeps an exponentially weighted speed record, scored against a 20 KiB/s floor, and segments prefer the best-scoring source that is not in cooldown.

**Two transports.** `node` uses the built-in `node:http`/`node:https` with keep-alive agents whose `maxSockets` is bounded by `--max-conns`. `curl` spawns the system `curl` and reads its stdout, which is useful where Node.js does not trust the local CA chain (corporate proxy, self-signed interception) and would report `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; `auto` (the default) starts with Node.js and switches to curl for that class of TLS error, or fails with a clear message if no curl is available. A `206` response is only accepted when its `Content-Range` matches the requested range exactly.

## Third-party sources and mirrors

- **No third-party proxy or mirror is used by default.** `--mirror-mode` defaults to `off`, so a plain `npx ghpull <url>` talks only to the host in the URL you gave.
- **The built-in mirror list is off unless you enable it.** It contains a few public third-party GitHub proxy services and is only consulted with `--mirror-mode auto`. Those services are run by volunteers, they are not affiliated with this project, and their availability, behaviour and legality are for you to assess.
- **This project does not provide, host, operate or endorse any proxy or mirror service.** `--mirror` and `--mirror-mode` only tell ghpull which additional URLs to try; the choice and its consequences are yours.
- **Segment reuse warning.** Mirrors and the origin must serve the *same* bytes for the same offsets. If you point a mirror at a different object than the origin, the merged file will be a mix of both — use `--sha256` when downloading from anything you do not fully control.

## Comparison with aria2, axel, wget2 and hget

These are mature, widely used multi-protocol downloaders, and this project is not a replacement for them. Rough star counts on GitHub (checked 2026-10-08, for scale only): [aria2](https://github.com/aria2/aria2) ~43k, [axel](https://github.com/axel-download-accelerator/axel) ~3.4k, [hget](https://github.com/huydx/hget) ~1k, [wget2](https://github.com/rockdaboot/wget2) ~0.8k.

| | ghpull | aria2 | axel | wget2 | hget |
| --- | --- | --- | --- | --- | --- |
| Runtime | Node.js >= 18, already installed | native binary | native binary | native binary | Go binary |
| Install | `npx ghpull` (nothing to download) | package manager or release binary | package manager or release binary | package manager or source build | Go install or release binary |
| Runtime dependencies | none | system libraries | system libraries | system libraries | none |
| Protocols | HTTP/HTTPS | HTTP/HTTPS, FTP, SFTP, BitTorrent, Metalink | HTTP/HTTPS, FTP | HTTP/HTTPS, FTP, and more | HTTP/HTTPS |
| Segmenting / multi-source | yes | yes (far more tuning) | yes | limited | yes |
| Resume | yes, two layers | yes | yes | yes | yes |
| SHA-256 check | yes, built in | via `--check-integrity` | no | no | no |
| BitTorrent / RPC / browser integration | no | yes | no | no | no |
| Scope | single-file downloads in a Node.js environment | general-purpose download engine | accelerator CLI | recursive mirroring, crawling | accelerator CLI |

The trade-off this project makes: it stays inside a Node.js >= 18 environment where `npx ghpull` already works, ships no native binary and no dependency tree, and deliberately does one thing — pull a single HTTP(S) file with segmented requests, resumable state and a digest check. If you need BitTorrent, Metalink, FTP/SFTP, an RPC interface, or years of protocol edge-case handling, use aria2 or wget2 instead; if you want a download accelerator without a Node.js runtime, use axel or hget.

### The predecessor in `legacy/`

`ghpull` grew out of a single-file downloader (`scripts/dl.mjs` in the workspace it was
written in). That version is kept here as a reference implementation and as a second
data point for comparisons: [`legacy/dl.mjs`](legacy/dl.mjs). It drives `curl.exe`,
plans its blocks up front and carries 26 offline self-checks; it is **not** part of the
published package and is not wired into the CLI. [`legacy/README.md`](legacy/README.md)
lists the differences.

## FAQ

**Does ghpull change how fast a download goes?**
It issues concurrent HTTP Range requests, picks the better of several sources, and retries stalled connections. Whether that helps depends entirely on the server, the link and the file: many hosts cap per-connection throughput (where segments help), while others are already saturating your link or limiting the total rate (where they do not). This project makes no speed promise, and no speed-up multiple is claimed anywhere in its documentation.

**Do I need aria2 or curl installed?**
No. Only Node.js >= 18. curl is optional and used only as a TLS fallback transport.

**Which URLs work?**
Any `http`/`https` URL — in practice the interesting ones are direct file links such as `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`. HTML pages are just files too; ghpull does not parse them or follow links, and it does not do recursive or batch downloading.

**Node reports `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. What now?**
That means Node.js does not trust the certificate chain (common behind a corporate proxy doing TLS interception). ghpull's `auto` transport detects this class of error and retries with the system `curl`, which uses the OS trust store. You can also set `NODE_EXTRA_CA_CERTS` to your proxy's CA, or force a transport with `--transport curl` / `--transport node`. Certificate verification is never disabled.

**The download was interrupted. Do I start over?**
No. Run the same command again with `--continue` (or just rerun it: ghpull notices its own parts directory). Bytes already on disk are reused; the summary line reports them as `reusedBytes`.

**I see a `<file>.ghpull/` directory next to my download.**
That is the parts directory: `state.json` plus one `seg-<start>.part` per segment. It disappears after a successful run unless you pass `--keep-parts`. On a checksum failure it is intentionally kept so nothing has to be re-fetched blindly.

**Can I run several downloads at once?**
Yes — separate processes, separate output paths. Each keeps its own parts directory, and the state files are written atomically.

**Does it verify the file without `--sha256`?**
It verifies internal consistency (every segment contiguous, total length equal to the announced size) and reports the computed SHA-256 in the summary, but a digest comparison only happens when you supply the expected value. A digest is never silently invented.

**How do I get the result in a script?**
`--json` writes NDJSON progress events and a final result object on stdout (with `ok`, `out`, `bytes`, `elapsedSec`, `avgBps`, `reusedBytes`, `fetchedBytes`, `fetchBps`, `peakConns`, `sources`, `transport`, `sha256`, and `mode: "single-stream"` for the fallback path). All human-readable output stays on stderr.

**Why not just use curl / Invoke-WebRequest?**
For a small file, do. This tool exists for large single files on links that drop or stall, where resume, a watchdog and a digest check matter more than a one-liner.

## Disclaimer

This program comes with no warranty. You must use this program at your own risk.

- ghpull is a client-side tool only. It downloads from URLs you give it, and it provides, hosts and operates no proxy, mirror or content service of its own.
- Third-party sources — including any mirror you configure and any service in the built-in list, if you enable it — are outside this project's control. Their availability, speed, integrity and legality are for you to judge before you rely on them.
- You are responsible for complying with the terms of service of the sites you download from, with their robots and rate-limit policies, and with the laws that apply where you are. Downloading copyrighted material without permission may be illegal.
- No express or implied warranty of merchantability, fitness for a particular purpose or non-infringement is provided. The authors and contributors are not liable for any damages arising from the use of this software.

## License

[MIT](https://github.com/zzfsaef/ghpull/blob/main/LICENSE) © ghpull contributors.

Contributions are welcome — see [CONTRIBUTING.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.md). To report a vulnerability, use [private reporting](https://github.com/zzfsaef/ghpull/security/advisories/new) as described in [SECURITY.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.md); please do not open a public issue for security problems.

Every reader-facing document exists in English and in Simplified Chinese: this file and [README.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/README.zh-CN.md), [CONTRIBUTING.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.md) / [CONTRIBUTING.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/CONTRIBUTING.zh-CN.md), [SECURITY.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.md) / [SECURITY.zh-CN.md](https://github.com/zzfsaef/ghpull/blob/main/SECURITY.zh-CN.md), and the files under [`legacy/`](https://github.com/zzfsaef/ghpull/tree/main/legacy).
