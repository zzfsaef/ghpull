# Security Policy

**English** · [简体中文](SECURITY.zh-CN.md)

## Supported versions

Only the version lines listed below receive security fixes. Older versions are out of
scope — please upgrade before reporting.

| Version | Supported |
| --- | --- |
| 0.1.x | :white_check_mark: supported |
| < 0.1 | :x: not supported |

## Reporting a vulnerability privately

**Please use GitHub Security Advisories:**

<https://github.com/zzfsaef/ghpull/security/advisories/new>

**Do not disclose security issues in a public issue.** Any discussion containing
vulnerability details, a PoC, or exploit information must stay out of public issues,
pull requests, discussions and social media until a fixed release exists.

This project provides no email contact.

## What to include in a report

- the affected version (`ghpull --version`) and the Node.js version (`node --version`);
- operating system and architecture;
- the type of issue and its impact (for example: writing outside the intended path,
  reading unexpected content, verification being bypassed);
- minimal reproduction steps or a PoC (public URLs or a local HTTP stub server are
  fine; **never** include private links or credentials);
- the behaviour you expected instead;
- optionally, how you intend to disclose the finding.

## What counts as a security issue here

ghpull is a client-only CLI with no server component. The most security-relevant
areas include (but are not limited to):

- **Output path handling**: can filename sanitising or path completion write outside
  the directory the user asked for (path traversal, symlinks)?
- **Temporary files and resume state**: can resume metadata or temporary part files be
  created or parsed in a way that external input controls?
- **URL and response handling**: can redirect following, multi-source candidates or
  mirror fallback be exploited by a malicious or hijacked source?
- **Transfer integrity**: can SHA-256 verification or overwrite protection be
  bypassed, and is there any path that silently writes the wrong content?
- **Resource consumption**: can a malformed response (odd `Content-Length`, unusual
  Range semantics, a body that never ends) cause unbounded memory or disk usage?
- **TLS and proxies**: is there any path that disables certificate verification by
  default, or ignores a verification failure?

Generally speaking, the content served by a third-party download source is not a
vulnerability in this project; what matters to us is whether ghpull can be induced to
do something it should not when it **faces** such a source.

## How we respond

Maintainers respond to security reports on a **best-effort** basis: this is a
volunteer-maintained open source project and **no SLA or fixed response or fix
deadline is promised**.

The usual flow is:

1. acknowledge the report and make an initial assessment;
2. discuss, reproduce and assess impact with the reporter in a GitHub Security
   Advisory;
3. prepare the fix and decide whether a patch release (`0.1.x`) is needed;
4. coordinate disclosure, publish the advisory once the fixed version is available,
   and credit the reporter where appropriate.

If you have not heard back within a reasonable time, you may ask for attention in a
repository issue **without disclosing details** (say only "I need a status update on a
security report" — never the technical details).

## Acknowledgements

We thank every researcher who reports issues privately and responsibly. Unless you
prefer to stay anonymous, we will credit you in the public advisory.
