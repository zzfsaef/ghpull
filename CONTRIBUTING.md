# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing to ghpull. This document describes how the
project is developed, the constraints every change must respect, and how to submit
your work.

## Scope and hard constraints

ghpull is a **client-only** multi-source segmented download CLI for pulling large
files from GitHub (and its mirrors) over slow links: concurrent HTTP Range segments,
multi-source selection, two-layer resume, a stall watchdog, SHA-256 verification and
overwrite protection.

Please preserve the following constraints in any change — they are requirements, not
suggestions:

- **Zero runtime dependencies.** `dependencies` and `devDependencies` must stay empty
  objects. Only the Node.js standard library is allowed. A proposal that needs a new
  dependency is usually rejected, unless you can show it is irreplaceable and a
  maintainer agrees.
- **Client-only.** No server component, and no hosted service that requires an
  account or a key.
- **Node.js >= 18** (see `engines` in `package.json`), ESM (`"type": "module"`).
- **No personal identity in the repository**: no real names, no email addresses, no
  local absolute paths, no private intranet addresses and no private links.

## Development setup

You only need Node.js (>= 18); nothing has to be installed to start. npm is a
convenience wrapper only (`npm run check` and `npm test` are exactly
`node tools/check-syntax.mjs` and `node --test`):

```bash
git clone https://github.com/zzfsaef/ghpull.git
cd ghpull
npm run check   # syntax check, zero dependencies
npm test        # unit tests
```

The project has no runtime dependencies and deliberately **does not commit a
`package-lock.json`**: CI and the release workflow call `node` directly, never run
`npm install`, and therefore never fail for a missing lockfile.

## Directory layout

| Path | Contents |
| --- | --- |
| `bin/ghpull.mjs` | CLI entry point (the `bin` field points at it) |
| `src/` | implementation; the public entry point is `exports` in `package.json` |
| `test/` | `node:test` tests |
| `tools/check-syntax.mjs` | zero-dependency syntax check script |
| `jsconfig.json` | type-check configuration (used by `npm run typecheck`) |

## Checks to run before submitting

```bash
npm run check          # syntax check
npm test               # unit tests
npm run test:coverage  # coverage (node --test --experimental-test-coverage)
npm run typecheck      # optional: npx --yes typescript@5 tsc -p jsconfig.json (needs network)
```

In the pull request description, paste the commands you **actually ran**, with a
summary of their output. Running only part of them is fine — just do not claim to
have run something you did not.

## Code style

- ESM, two-space indentation, LF line endings, UTF-8; the exact rules live in
  `.editorconfig` and `.gitattributes`.
- Add tests when you add or change behaviour. Prefer tests that reproduce offline
  (local fixtures, injectable HTTP stubs) over tests that need the public network.
- Keep commit messages short and imperative (for example
  `fix: resume after watchdog stall`).

## Submitting changes

1. Fork the repository and create a topic branch from the default branch.
2. Make the change and run the checks listed above.
3. Open a pull request and fill in the repository's PR template: change type, what
   you actually ran, and the checklist.
4. A maintainer will review it. If the change touches public behaviour or CLI
   options, describe the migration path explicitly.

## Reporting problems

- **Bugs and feature requests**: use the repository's issue templates, and fill in
  the version, OS and full command they ask for.
- **Usage questions and discussion**: <https://github.com/zzfsaef/ghpull/discussions>.
- **Security vulnerabilities**: **do not** open a public issue. Report privately via
  <https://github.com/zzfsaef/ghpull/security/advisories/new>; see `SECURITY.md`.

The project communicates only through these GitHub channels and provides no email
contact.

By participating, you agree to follow the `CODE_OF_CONDUCT.md`.
