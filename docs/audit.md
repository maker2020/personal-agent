# npm audit

`npm audit` after the overrides in `package.json`:

| Severity | Count |
|---|---|
| high | 0 |
| critical | 0 |
| moderate | 12 |

Overrides:

- `zod` → `4.6.7` (the pinned DeepSeek Harness packages depended on `zod@4.4.3`, which is below the fix in `4.6.7`)
- `undici` → `8.12.3` (Harness pulled `undici@8.11.2`)

`puppeteer-core` was removed. The browser check uses Chrome's DevTools protocol directly, which drops the `extract-zip` and `basic-ftp` findings.

## What remains

Twelve moderate findings, all transitive through `@deepseek-ai/dsh@0.2.1-rc.2`:

- `@modelcontextprotocol/client` — HTTP and OAuth transports can follow cross-origin redirects and resend headers. Hearth does not configure MCP servers by default. Replacing the client would mean leaving the pinned harness release.
- `fflate` — `unzipSync` can loop on a malformed ZIP64 archive. It is pulled in by the harness, not by Hearth's request path.

No high-severity findings remain.
