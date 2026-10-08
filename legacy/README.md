# Reference: the single-file predecessor

`dl.mjs` in this directory is the **previous generation** of the download engine that
`ghpull` grew out of: one self-contained file, driven by `curl.exe`, with a static
block plan and a work-stealing queue. It is kept here as a reference point and as a
second implementation to compare against; it is **not** part of the published
package (`package.json` lists only `bin/`, `src/` and the documentation, so `legacy/`
never ships in the tarball) and it is not wired into the CLI.

## How it differs from `ghpull`

| | `legacy/dl.mjs` | `ghpull` |
|---|---|---|
| Layout | one 871-line script | `src/` modules with a documented API |
| Transport | external `curl.exe` only | built-in `node:http`/`node:https`, with `curl` as a fallback (`--transport auto`) |
| Block plan | fixed plan up front, work-stealing queue | segments split and re-split while the transfer runs |
| Resume | part files plus `state.json` | two-layer resume, `state.json` treated as a hint, disk size as the authority |
| Source choice | race at startup, then per-block retry | per-source speed records, degradation, cooldown, bounded race budget |
| Startup cost | a probe round that can fail the whole run | probe with mirror fallback |
| Tests | 26 offline self-checks (`--self-test`) | 112 tests (`node --test`), plus negative-control scripts |
| Reuse | workspace script | installable package (`bin`, `exports`, `files`), zero dependencies |

## Using it

```
node legacy/dl.mjs <url> -o <file> [--conns 8] [--mirror <prefix>] [--sha256 <hex>]
node legacy/dl.mjs --self-test      # 26 offline checks, no network
```

Exit codes: `0` success, `1` usage or network failure, `3` output exists (no `--force`),
`4` digest mismatch.

## One adaptation

The original file resolved relative `--out` paths through a workspace-local helper
(`import { WS } from "./_paths.mjs"`). That helper is not carried here, so the copy
defines `const WS = process.cwd()` instead; behaviour is the same for absolute paths
and for paths relative to the current directory. Everything else is verbatim,
including the four hardening notes in the header comment that were back-ported from
the newer engine (part-size reconciliation, strict `Content-Range` checking,
per-part length validation before merging, and immediate cancellation on `Ctrl-C`).
