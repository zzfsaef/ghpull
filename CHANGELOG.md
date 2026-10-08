# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-08

First release.

### Added

#### Transfer

- Concurrent segmented transfers over HTTP Range requests, with the concurrency
  target bounded by `--conns` and `--max-conns`.
- Segment re-splitting while the transfer runs: a segment larger than twice
  `--min-split` is split at the midpoint of its not-yet-downloaded region, so
  bytes already on disk stay valid.
- Closing-phase re-splitting, which lowers the split threshold and raises the
  connection ceiling so the last few megabytes are not carried by one connection.
- Adaptive concurrency: throughput is sampled every 6 seconds and the connection
  target moves by ±2 depending on whether the measured rate improved by at least
  5%, bounded by `1` and `--max-conns`.
- Single-stream fallback when the server does not support ranges: the transfer is
  performed as one request and the summary reports `mode: "single-stream"`.

#### Sources

- Optional additional sources via `--mirror` templates, which must contain the
  `{url}` placeholder; `--mirror-mode` selects `off` (default), `manual` or `auto`.
- Built-in list of third-party mirror templates, disabled unless
  `--mirror-mode auto` is given.
- Source racing: when more than one candidate exists, each candidate transfers a
  256 KiB probe and candidates within 50% of the fastest are kept.
- Per-source speed records (exponentially weighted average with a degradation
  reset) used to order candidates when a segment picks a source.
- 30-second cooldown for a source that failed a segment.

#### Resume and state

- Two-layer resume: a run interrupted mid-transfer reuses the parts left in
  `<output>.ghpull/`, and a completed output file whose size already matches the
  remote object is accepted without a further request.
- Parts directory layout `<output>.ghpull/`, holding `seg-<start>.part` payload
  files named by their starting offset (segments are split while running, so a
  sequence number would drift) plus `state.json` with the URL, size, optional
  digest and the segment table.
- `state.json` written atomically (temporary file plus rename) at intervals, so an
  interrupted write cannot leave a half-written state behind.
- Each part file is re-checked against its expected length on resume; a truncated
  or oversized part is discarded and re-fetched.
- `--no-resume` to discard existing part state, and `--keep-parts` to retain the
  parts directory after a successful transfer.

#### Watchdogs and retries

- Stall watchdog: a segment that produces no new bytes for `--stall-sec`, or whose
  average falls below `--lowest-speed` after 10 seconds, is aborted and re-queued.
- Per-segment retries up to `--retries` (default 5), after which the run fails with
  exit code `6` when every candidate source has been exhausted.
- Request timeout `--timeout`, applied per request, and a redirect limit of 5 hops.

#### Verification and placement

- SHA-256 verification with `--sha256`: the digest is computed while parts are
  merged, and a mismatch discards the merge, keeps the parts and exits `4`.
- Placement by rename from a temporary file next to the destination, after segment
  boundaries have been checked to be contiguous and to cover the announced size.
- Overwrite protection: an existing destination is refused before any network
  request is made, unless `--force` or `--continue` is given.
- Zero-length resources produce an empty file whose digest is still verified when
  `--sha256` was given.

#### Interface

- `ghpull <url>` CLI with the documented options defined in `src/args.mjs`, and
  size values accepting `B`, `K`/`KiB`, `M`/`MiB`, `G`/`GiB`, `T`/`TiB` suffixes.
- Progress modes `auto`, `plain`, `none` and `json`; human-readable output is
  written to stderr so a pipeline reading stdout stays clean.
- `--json` result summary on stdout for both success and failure.
- JSON configuration file via `--config`, whose keys act as defaults and are
  overridden by options given on the command line.
- Programmatic API exported from the package entry (`download()`, `Engine`,
  `probe()`, `openRange()` and the error types).
- Stable exit codes as part of the public interface.

  | Code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | Failure |
  | `2` | Usage error |
  | `3` | Destination exists |
  | `4` | Checksum mismatch |
  | `5` | Unsupported target |
  | `6` | No usable source |
  | `130` | Interrupted by `SIGINT`/`SIGTERM`; parts are kept |

#### Transports

- Two transports: the built-in `node:http`/`node:https` implementation (default)
  and the system `curl` executable.
- `--transport auto` starts with the built-in implementation and retries with
  `curl` for the class of TLS certificate errors that Node.js reports when it does
  not trust the peer chain, failing with an explanatory message when no `curl` is
  available. Certificate verification is never disabled.
- `--curl-path`, plus `$GHPULL_CURL` and `PATH` detection, to locate the `curl`
  executable.

#### Project

- Zero runtime dependencies: only the Node.js standard library is used, and
  nothing is downloaded at install time.
- `engines.node` is `>= 18`; the package declares `win32`, `darwin` and `linux`.
- MIT license.

### Fixed

- A ranged response is accepted only when the number of body bytes equals the
  length that was asked for. A body that ends early or carries extra bytes now
  fails that segment (and is retried or reported) instead of being merged into
  the output.
- Splitting a segment whose write loop is still running no longer loses data.
  The aborted writer keeps ownership of the segment until its loop has drained
  and the stream is closed, writes are bounded by the segment length as it is at
  that moment, and the part file is re-checked against that length afterwards.
  Previously a split could leave `done` counted up to the segment length while
  the part file was shorter, so the merged output was silently incomplete.
- Part files are named by their starting offset alone (`seg-<start>.part`), which
  does not change while a segment is alive. Encoding both ends meant that
  splitting a running segment renamed the file and stranded the bytes already
  written under the old name, which shortened the merged output by exactly the
  number of bytes downloaded before the split.
- `--transport curl`: the header file is no longer removed by the child's exit
  handler before the response headers have been read from it, the child-exit
  promise is installed before the header phase (a `curl` that exits early can no
  longer leave the transfer waiting forever), and `--speed-limit 1` with
  `--speed-time <stall-sec>` makes `curl` enforce the same stall threshold as the
  watchdog.
- Range support is confirmed with an actual `Range: bytes=0-0` request before the
  segmented path is chosen; a server that advertises `Accept-Ranges: bytes` but
  answers a ranged request with `200` now falls back to a single stream instead
  of failing later.
- `--transport curl`: the child's stdout is taken over by a `PassThrough` straight
  after `spawn`. On Windows a piped stdout that is first read after the child has
  exited yields no data at all, and the header phase always costs at least one
  polling interval, so the transferred body could come back empty and leave the
  transfer promise waiting forever.
- A cancelled transfer is reported as cancelled instead of as a network failure:
  the abort signal is wired to the segment abort path, and abort-driven stream
  errors are translated rather than surfaced as `ECONNRESET`/`aborted`.
- A response stream that has already ended or been destroyed when the body reader
  is attached now settles immediately (and fails loudly on a byte mismatch)
  instead of leaving the transfer waiting forever.
- The `Range: bytes=0-0` verification request keeps its `Range` header when the
  caller supplies its own headers, so a range-capable server is no longer
  misjudged as single-stream-only.
- `state.json` is treated as a hint rather than as fact: only a shape- and
  range-consistent state is used, and the size of each part file on disk is the
  final authority on how much of a segment is already present.

### Security

- Redirects that leave the origin of the current URL no longer forward the
  `Authorization`, `Cookie` or `Proxy-Authorization` request header.

[Unreleased]: https://github.com/zzfsaef/ghpull/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zzfsaef/ghpull/releases/tag/v0.1.0
