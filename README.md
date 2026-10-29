# dsh-outline

[简体中文](./README.zh-CN.md)

A DeepSeek Harness plugin that searches and reads an [Outline](https://www.getoutline.com/) knowledge base from your conversation. Give it a keyword — it returns matching documents with **titles, snippets, and links**; ask for one of them and it returns the **full content in Markdown**. Approved write tools can create, update, and delete documents, with an approval prompt before every write.

> Project status: 0.9.1. The current feature set is covered by unit tests (233 tests with cross-platform edge cases), a Mock-server smoke, and a settings-chain integration check. Supported platforms: Windows / macOS / Linux. The supported DSH baseline is `0.1.5-rc.2` (`settings.installSection` is required for the settings card); the dsh `0.2.x` line (`>=0.2.0-rc.1 <1.0.0`) is also adapted. Older Harness builds are not certified.

## The core idea

- The knowledge base is one search away: **you give a keyword, it gives you document links**.
- Read operations are available without write access; write operations are separately approved by the user.
- Each user brings their own credentials: **fill in the card in the GUI, no config files**.
- Setup per team member is the same three steps: install → restart → configure.

## Features

- **Thirteen tools** — search (filter by author name, server-side), context search (returns each hit's excerpt body text, ready to quote), read, count, list collections, list users, resolve paths, list children, return a document template, save documents to a local Markdown file (one or many, merged with a table of contents), create, update, and delete.
- **Author-aware search** — `outline_search` accepts an `author` name/email that resolves against `outline_list_users` and is pushed down to Outline as a server-side `userId` filter; hits carry the author's display name when available.
- **Clickable results** — document links are resolved to absolute URLs against your `baseUrl` (Outline returns relative paths); snippets and titles are cleaned of HTML tags so results render cleanly in chat.
- **Configurable read cache (default 60s TTL, capped entries)** — re-reading the same document within a session does not hit the API again; write tools invalidate the cache so edits are visible immediately; the TTL is configurable via `cacheTtlMs` and the cache has an entry cap to bound memory.
- **429 retry with backoff** — rate-limited requests automatically retry up to 3 times (respecting `Retry-After`, otherwise exponential backoff capped at 5s).
- **HTTPS enforcement** — public URLs must use `https://` (localhost and private intranet addresses are exempt) so the API token is never sent in clear text.
- **GUI configuration card** — Settings → Plugins → plugin configuration, an **Outline Knowledge Base** card matching the official card UI; fill in `baseUrl` and API token, click save, done.
- **Per-user credentials** — every user configures their own token in the GUI (stored under `$DSH_HOME/settings.yaml`, never in git); ideal for team distribution.
- **Safe when unconfigured** — the plugin loads normally and tools return clear Chinese error messages; the GUI is never blocked.
- **Live updates** — saving the card applies immediately, no restart; configuration priority: GUI card → environment variables → plugin config row.
- **Enable/disable** — listed in Settings → Plugins → Plugin list after the host entry is active; the configuration card is under Settings → Plugins → Plugin configuration.
- **Ready to distribute** — install from the public GitHub repository or archive after the release checklist below passes. Recipients should use the DSH plugin installer instead of manually editing profile bundles.

## Requirements

| Component | Baseline |
| --- | --- |
| Platform | Windows / macOS / Linux |
| Node.js | 22.19 or newer |
| DeepSeek Harness | `0.1.5-rc.2` baseline; `0.2.x` (`>=0.2.0-rc.1 <1.0.0`) adapted |
| Outline instance | reachable from your machine (intranet / VPN), with an API token (Outline → Settings → API keys) |

## Outline version compatibility

The plugin talks to eight core endpoints (`documents.search|list|info|create|update|delete`, `collections.list`, `users.list`), whose request and response shapes have stayed the same from `v0.79` through `v1.12`. What does change across versions is a few request parameters, and the plugin adapts at runtime instead of pinning one version's syntax:

| Capability | v0.79 – v1.8 | v1.9 – v1.11 | v1.12+ |
| --- | --- | --- | --- |
| Append to document body | `append: true` | `editMode: "append"` | `editMode: "append"` |
| Collection / author filter | top-level `collectionId` / `userId` | same (deprecated) | `filters` array, **mutually exclusive** with the legacy keys |
| Time filter (`updatedAfter`) | not supported by the server | not supported | `filters` with `updatedAt` + `gte` |

How that is handled:

- **Append sends both keys.** With `append: true` the request carries `append: true` *and* `editMode: "append"`. Older servers ignore `editMode`; newer ones convert `append` into `editMode` and delete it. Sending only one of them silently degrades to a **full overwrite** on the other side — no error, just replaced content, which is why both are always sent.
- **Time filtering is probed once per instance.** A `documents.list` with a future-dated `updatedAt` filter tells the plugin whether the server honours `filters` (empty result = yes, real total = the field was stripped). Supported instances get the filter pushed down and return `timeFilterMode: "server"`; older ones have the page filtered locally and return `timeFilterMode: "client"`; when the query is **empty**, it instead pages through `documents.list` (naturally ordered by `updatedAt` descending) and stops at the time boundary, returning `timeFilterMode: "list"` — exact, one request. The legacy server has no `updatedAfter` parameter at all — it never existed in any Outline release, so there is nothing to send.
- **Collection / author filtering keeps the top-level keys**, which every version accepts. They are deprecated in 1.12+ but not removed; the `filters` path is entered only when a time filter is also requested, because the server rejects the two combined.

## Installation

### Recommended: DSH-managed install

Install from the public GitHub repository, pinned to the latest release tag:

```bash
dsh plugin --profile web add git+https://github.com/huangfuren/dsh-outline.git#v0.9.1
```

The `#v0.9.1` suffix pins the exact release; omit it to track the latest commit on `main`.

Restart `dsh web` after installation. The published package contains the built `lib/` directory, so a normal Git install does not depend on a local build step. This package ships **no install lifecycle scripts**: the `postinstall` cleanup hook it used to carry trips pnpm's build-script approval (`ERR_PNPM_IGNORED_BUILDS`), which aborts installation on newer surfaces such as the desktop app.

For an AI-assisted installation, use the DSH plugin manager command above and do not manually add a second `cordis.patch.yml` entry or edit `dsh.profile.bundles`. If startup still fails and the error names another plugin, repair or disable that named plugin separately.

For a local checkout or extracted archive:

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-outline
```

The directory must contain `package.json`, `lib/index.js`, `client.js`, `cordis.patch.yml`, and `dsh.plugin.json`. Build the package before distributing an archive:

```bash
pnpm build
```

### Legacy hot-install script

The `scripts/hot-install.mjs` flow is intended for local development only. It creates a profile link and a patch row, so keep the checkout in a stable directory. Do not use it as the public distribution instructions.

### Recovery after a failed install

```bash
dsh plugin --profile <profile> why dsh-outline
```

Pass the profile you actually use — `web` for the browser surface, `desktop` for the desktop app.

If startup reports that it cannot resolve `dsh-outline-ai`, an older renamed entry remains in that profile's `package.json` or `cordis.patch.yml`. This package no longer ships an automatic migration script: delete those stale lines by hand, reinstall the package, and restart.

If the install fails with `ERR_PNPM_IGNORED_BUILDS`, or the profile's `pnpm-workspace.yaml` grows an `allowBuilds: … set this to true or false` entry for this package, the cause is the `postinstall` hook of a pre-v0.8.2 release. Upgrade to v0.8.2 or later (the hook is gone) and drop the pending `allowBuilds` line.

If the package loads but the card is absent, restart `dsh web`, open Settings → Plugins, check **Plugin list** for `dsh-outline`, then check **Plugin configuration**. A failed host entry will not expose its settings namespace.

## Configuration

The recommended way is the **GUI card** (Settings → Plugins → plugin configuration → Outline Knowledge Base):

| Field | Description |
| --- | --- |
| Service URL (baseUrl) | Outline instance root, e.g. `https://outline.example.com` |
| API Token | create one at Outline → Settings → API keys |
| Writable paths (empty = read-only) | comma-separated directory paths, e.g. `Collection A,Knowledge Base/Dir 1`; only these directories and their children are writable |
| Local save directory | local directory where `outline_save_local` writes Markdown files; empty = `$DSH_HOME/outline-auto-saves` (fallback `$HOME/outline-auto-saves`). Restart the web profile after changing |
| Synonyms (config row only) | `synonyms` in the plugin config row (YAML map, e.g. `synonyms: { 部署: [上线, 发布] }`): on a zero-hit search the plugin retries with mapped words (ladder: original → first word → synonyms) before giving up |

Click **Save** — applies immediately. Alternatively, configure via environment variables (`OUTLINE_BASE_URL` / `OUTLINE_API_TOKEN`) or the plugin config row in `cordis.patch.yml`. Advanced options in the plugin config row: `timeoutMs` (request timeout, default 15000), `cacheTtlMs` (read-cache lifetime in ms, default 60000, range 1000–300000) and `synonyms` (see above; config-row only, restart to reload).

**Read-only by default (v0.3.0)**: with no writable paths configured, all write tools (`outline_create` / `outline_update_document` / `outline_delete`) refuse to run — no approval prompt is even shown. To allow writes, list the directories that may be modified. A path like `Knowledge Base/Dir 1` covers every child under `Dir 1`; a bare `Collection A` covers the whole collection. Any path that cannot be resolved (missing collection, invisible directory, moved document) is refused — writes always fail closed.

The public package must not contain organization-specific collection names, URLs, tokens, or document examples. Deployment-specific values are configured per installation — never publish an internal collection name as a schema default or UI placeholder.

### Migrating from 0.2.x

0.3.0 removes the `protectedCollections` deny-list in favor of the `writablePaths` allow-list. After upgrading, **every write is refused until you configure writable paths**. If you previously protected a collection via the deny-list, simply leave it out of `writablePaths` — a collection that is not listed is not writable. Delete the old `protectedCollections` setting from your plugin config row, then set `writablePaths` to the directories you actually write to.

## Tools

| Tool | Description |
| --- | --- |
| `outline_search(query, limit?, offset?, collectionId?, author?, userId?, updatedAfter?, all?)` | Keyword search; returns the match **total**, plus title, snippet, document id, author name and link per hit. Optional filters: collection, author (name/email — resolved via users.list and pushed down server-side as `userId`; ambiguous names return the candidate list), updated-after; `offset` skips the first N hits for pagination; `all=true` auto-paginates and de-duplicates up to 100 hits. **An empty `query` skips keyword search entirely**: results come from `documents.list` ordered by `updatedAt` descending, which makes "what changed recently" exact on every Outline version. Identical queries are short-TTL cached (invalidated by writes); multi-word queries with zero hits automatically retry with the first word. |
| `outline_context_search(query, limit?, collectionId?)` | **Enhanced search** — keyword search that also returns each hit's **excerpt**: the first 800 characters of the document body, not just the server snippet. Lets the model quote content in one step instead of calling `outline_get_document` per hit. Excerpts are fetched concurrently (≤4) and reuse the 60s document cache; multi-word queries with zero hits retry with the first word. |
| `outline_get_document(id, maxLength?)` | Fetch a document's full Markdown by id; `maxLength` caps the returned text (default 20000). |
| `outline_count()` | Total number of documents in the knowledge base (`documents.list` total, exact; excludes trashed/deleted — the true total may be slightly higher). |
| `outline_list_collections()` | List visible collections (id, name, permission, document count). |
| `outline_list_users()` | List workspace users (id, name, email) — resolve "documents by 张三" into the author/userId filter for `outline_search`. |
| `outline_resolve_path(path)` | Resolve a human path like `Knowledge Base/Directory A/Subdirectory` into `collectionId` + `parentDocumentId`; returns the resolved full path. |
| `outline_list_children(parentId)` | List direct child documents of a directory (parent document). |
| `outline_doc_template()` | Return the standard requirement-document template (Markdown) + required section list — call it before writing a requirement doc. |
| `outline_save_local(ids, title?)` | **Local save** — write one or many fetched Outline documents to a local Markdown file. `ids` is a comma-separated list from search results (up to 50); multiple docs merge into one file with a table of contents. Filename `YYYY-MM-DD-title.md` (single doc → its title, many → `首篇标题等N篇`); auto-increments on name clash, never overwrites. **Writes only to local disk; never touches the knowledge base.** Search/get_document results end with a prompt offering this. |
| `outline_create(collectionId, title, text, publish?, parentDocumentId?)` | **Write** — create a document (default published; nest under a directory via `parentDocumentId`). **Requires approval** showing the resolved full path. |
| `outline_update_document(id, title?, text?, append?, publish?)` | **Write** — update a document's title/body/publish state. **Requires approval** showing the document path. `text` **replaces** the whole body; pass `append: true` to append instead of overwriting. |
| `outline_delete(id)` | **Write, irreversible** — delete a document. **Double approval**: a first prompt, then a second confirmation before deletion. Reported successful only when the server returns an explicit success flag. |

> Writes are restricted to the **writable paths** configured per deployment (read-only when empty). The public package ships with no organization-specific default.
>
> **Long documents.** `outline_get_document` returns at most 20000 characters by default, while `outline_update_document` replaces the whole body. If you write back a truncated read (the new text is an exact prefix of the original, or exactly the default cap), the approval prompt states the exact numbers — "original N chars → writing M chars, K chars will be permanently lost" — and how to fix it. Use `append: true` when you only mean to add content.
>
> **Unknown write arguments are rejected.** The host does not force tool parameter schemas closed (undeclared keys pass silently), so each write tool validates its own argument keys — no "parameter accepted, success returned, change never applied".
>
> **`publish`** is accepted by both `outline_create` and `outline_update_document`. When the instance does not echo a publish state, the tools say so rather than reporting a draft as published.

### Workflow: writing a requirement document (common task)

See the full SOP: [`docs/workflow-requirement-doc.zh.md`](docs/workflow-requirement-doc.zh.md) — locate the directory (`outline_resolve_path`) → fetch the template (`outline_doc_template`) → draft → create with approval → verify.

## Security

Every write goes through native DSH approval and a per-deployment directory allow-list, and both fail closed: an unavailable approval service, an error inside the gate, or an unresolvable target path all refuse the write instead of performing it. On top of that the plugin registers the host's **monotonic guard** (`ctx.tools.guard`) as a floor: unlike the reorderable `tools/pre-execute` waterfall it cannot be overridden by any listener, so writes are still refused even if the gate is short-circuited by another plugin or never installed at all. Public instances must use HTTPS (loopback and private intranet hosts are exempt), API tokens stay in the DSH settings layer and never reach tool output, logs, or the browser half, and `outline_delete` asks for a second confirmation (the second prompt is raced against the caller's signal, so cancelling the turn aborts it) and only reports success when the server explicitly says so — an unconfirmable result is reported as an error, never as "deleted". Local Markdown saves are confined to the configured save directory and refuse disk roots, filesystem roots, share roots and known system directories; that is a seatbelt, not a sandbox. The check runs after collapsing `.`/`..` segments and matches system directories with the drive letter stripped, so a `..`-laden path and a non-`C:` Windows install are both covered. Save paths keep their per-platform filename and path-length hardening.

> **With the approval policy set to "never", every write is refused.** That is DSH's designed fail-closed behaviour (no approver available means deny), not a plugin fault. Switch the policy back to "ask" to allow writes.

See [SECURITY.md](./SECURITY.md) for the full threat model and for how to report a vulnerability privately.

## Cross-platform compatibility

Windows, macOS and Linux are all first-class targets; every key code path is platform-agnostic and CI verifies Node 22 / 24 across all three operating systems. Nothing needs to be configured per platform.

**Windows**

- Backslash input is normalized to forward slashes, so `Collection A\Dir 1` resolves like `Collection A/Dir 1`.
- Filenames are sanitized — characters illegal on Windows are replaced and reserved device names (`CON`, `NUL`, `COM1-9`, `LPT1-9`) are rewritten — and leading/trailing dots and spaces are normalized so names cannot be silently trimmed.
- Paths that would exceed the Windows `MAX_PATH` limit (260) are truncated while preserving the `.md` extension.
- Filesystem errors (`ENOENT`, `EACCES`, `ENOSPC`) are translated into actionable hints naming the likely Windows cause.
- The home-directory fallback chain (`$DSH_HOME` → `$USERPROFILE` → `$HOME` → cwd) matches where Windows keeps user profiles.

**macOS / Linux**

- IPv6 loopback (`http://[::1]:3000`) is recognized as a private address and is not rejected by HTTPS enforcement.
- De-duplication behaves correctly on case-insensitive filesystems (APFS by default, optional on ext4).
- Markdown is always written with LF endings, and Unicode filenames survive NFD/NFC differences, so emoji and CJK titles save cleanly.
- POSIX path limits (1024+ characters) are well above Windows, so titles are not truncated.

**Known boundaries (by design, not defects)**

| Situation | Behavior | Impact |
| --- | --- | --- |
| Case-insensitive macOS filesystem | `Test.md` and `test.md` are the same file; a clash becomes `test-2.md` | intended — never overwrite |
| Windows MAX_PATH (260) | very long titles are truncated to a safe length | protection working |
| Legacy Notepad before Windows 10 | LF-only files render oddly | use VS Code / Notepad++ |
| iOS / Android | not supported (Node.js 22.19+ cannot run there) | desktop platforms only |

## Release checklist

- Verify the package with the exact supported DSH baseline and Node.js baseline.
- Run `pnpm typecheck`, `pnpm build`, `pnpm test`, and `node scripts/smoke.mjs`.
- Inspect the archive contents: include built `lib/`, `client.js`, both manifests, the patch, and public documentation; exclude `node_modules`, `.git`, settings files, tokens, internal URLs, and internal document names.
- Install the archive or GitHub URL into a clean `web` profile and confirm both Settings -> Plugins -> Plugin list and Plugin configuration.
- Search the release tree for organization-specific names before publishing. A failed check blocks the release.

## Development

```bash
pnpm typecheck          # strict tsc check
pnpm build              # emit lib/
pnpm test               # vitest unit tests (mock fetch: success/empty/401/403/404/429/network/bad response)
node scripts/smoke.mjs  # local Mock Outline server, end-to-end smoke (prints SMOKE PASS)
node scripts/verify.mjs                # real settings → search → count chain (add --create for the create+cleanup chain)
```

The client half (`client.js`) is a dependency-free single-file module — no build step. The real-search verification script requires `OUTLINE_BASE_URL` / `OUTLINE_API_TOKEN` env vars.

## License

[MIT](./LICENSE)
