# Security policy

## Supported versions

Security fixes are provided for the latest released pre-1.0 version only (`0.7.x`). Install an immutable Git tag and upgrade when a new release is published:

```bash
dsh plugin --profile web add git+https://github.com/huangfuren/dsh-outline-auto.git#v0.7.3
```

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, credential leak, approval bypass, or path-traversal / arbitrary-write problem.

Use GitHub's private vulnerability reporting or a private Security Advisory for `huangfuren/dsh-outline-auto`. Include:

- affected plugin version plus DSH, Node.js and operating system versions;
- reproduction steps or a minimal proof of concept;
- expected impact (read leak / unauthorized write / local file overwrite);
- suggested remediation, if available.

If private reporting is unavailable, contact the repository owner privately before disclosing details. Please allow a reasonable remediation window before public disclosure.

## Security model

### Credentials

- Every user configures their own Outline API token in the GUI card (Settings → Plugins → Plugin configuration); tokens are stored in the DSH settings layer, never in the repository, never in the published package.
- Tokens are resolved on the DSH host for each request. They are never echoed into tool results, logs, or error messages, and never sent to the browser half.
- `OUTLINE_API_TOKEN` is supported as an environment-variable fallback for local development only.

### Transport

- A public `baseUrl` must use `https://`; plain HTTP is rejected so the API token is never sent in clear text.
- Loopback and private intranet hosts are exempt so intranet and VPN deployments still work. The private-address detector covers `localhost`, `127.0.0.1`, `0.0.0.0`, and bracketed IPv6 loopback (`[::1]`), plus documented private ranges.

### Write authorization (fail closed)

Writes are gated by a `tools/pre-execute` hook that requests native DSH approval before every `outline_create` / `outline_update_document` / `outline_delete`. The gate fails closed:

- approval service unavailable → the write is denied, not performed;
- an exception inside the gate itself → the write is denied and reported;
- the tool is invoked without going through the hook → tool-level argument validation refuses it;
- `outline_delete` (irreversible) requires a **second** confirmation after the first approval.

Restricting UI paths is not sufficient: the checks live in the host half, so a direct tool call cannot skip them.

### Directory allow-list (fail closed)

- Writes are limited to `writablePaths` configured per deployment. An empty list means read-only: every write tool refuses before any approval prompt appears.
- A target path must resolve inside an allow-listed directory. Unresolvable paths (missing collection, invisible or moved document) are refused.
- Since v0.3.0 the model is an allow-list; the old `protectedCollections` deny-list was removed.

### Local file writes

`outline_save_local` writes Markdown to the local disk only and never touches the knowledge base. Protections:

- target directories are resolved from the configured local save directory; traversal outside it is refused;
- path traversal sequences and characters illegal per platform are stripped or rejected;
- Windows reserved device names (`CON`, `NUL`, `COM1-9`, `LPT1-9`) are rewritten so they cannot silently fail or hijack a device;
- leading/trailing dots and spaces are normalized (Windows would otherwise silently trim `file.md.` to `file.md`);
- paths longer than the Windows `MAX_PATH` (260) limit are truncated while preserving the `.md` extension;
- de-duplication retries are capped (51 attempts) before falling back to a timestamp suffix, so a name clash can never loop forever;
- the file is never overwritten — clashes auto-increment instead.

### Caching

The read cache is bounded: entries expire (`cacheTtlMs`, default 60s, allowed range 1000–300000) and the entry count is capped. Write tools invalidate the cache so edits are visible immediately. The cache holds no credentials.

### Release hygiene

The published package must not contain organization-specific collection names, instance URLs, tokens, or real document content. Deployment-specific values are configured per installation.

## Out of scope

The plugin cannot protect against a compromised Outline token, a hostile Outline administrator, or an operator who deliberately disables the approval service at the host level. Trust boundaries end where operator control begins.
