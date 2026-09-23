# dsh-outline

[简体中文](./README.zh-CN.md)

A DeepSeek Harness plugin that searches and reads an [Outline](https://www.getoutline.com/) knowledge base from your conversation. Give it a keyword — it returns matching documents with **titles, snippets, and links**; ask for one of them and it returns the **full content in Markdown**. Approved write tools can create, update, and delete documents, with an approval prompt before every write.

> Project status: 0.8.0. The current feature set is covered by unit tests (152+ tests with cross-platform edge cases), a Mock-server smoke, and a settings-chain integration check. Supported platforms: Windows / macOS / Linux. The supported DSH baseline is `0.1.5-rc.2` (`settings.installSection` is required for the settings card); older Harness builds are not certified.

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
| DeepSeek Harness | `0.1.5-rc.2` (required baseline) |
| Outline instance | reachable from your machine (intranet / VPN), with an API token (Outline → Settings → API keys) |

## Installation

### Recommended: DSH-managed install

Install from the public GitHub repository, pinned to the latest release tag:

```bash
dsh plugin --profile web add git+https://github.com/huangfuren/dsh-outline.git#v0.8.0
```

The `#v0.8.0` suffix pins the exact release; omit it to track the latest commit on `main`.

Restart `dsh web` after installation. The published package contains the built `lib/` directory, so a normal Git install does not depend on a local build step. Its install hook only removes stale references to this plugin's old package name (`dsh-outline-ai`) from the selected DSH profile; it does not remove or rewrite unrelated plugins.

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
dsh plugin --profile web why dsh-outline
```

If startup reports that it cannot resolve `dsh-outline-ai`, an older renamed entry remains in `%USERPROFILE%/.dsh/profiles/web/package.json` or the profile `cordis.patch.yml`. Reinstall this package in the affected profile; the install hook migrates the stale references when package lifecycle scripts are enabled. For a profile where scripts were disabled, run this explicit repair:

```powershell
node node_modules/dsh-outline/scripts/repair-profile.mjs --profile-dir "$env:USERPROFILE/.dsh/profiles/web"
```

Then run the DSH plugin manager once to refresh the profile lockfile before restarting `dsh web`. Do not rename the current package back to the old id.

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
| `outline_search(query, limit?, offset?, collectionId?, author?, userId?, updatedAfter?, all?)` | Keyword search; returns the match **total**, plus title, snippet, document id, author name and link per hit. Optional filters: collection, author (name/email — resolved via users.list and pushed down server-side as `userId`; ambiguous names return the candidate list), updated-after; `offset` skips the first N hits for pagination; `all=true` auto-paginates and de-duplicates up to 100 hits. Identical queries are short-TTL cached (invalidated by writes); multi-word queries with zero hits automatically retry with the first word. |
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
| `outline_update_document(id, title?, text?)` | **Write** — update a document's title/body. **Requires approval** showing the document path. |
| `outline_delete(id)` | **Write, irreversible** — delete a document. **Double approval**: a first prompt, then a second confirmation before deletion. |

> Writes are restricted to the **writable paths** configured per deployment (read-only when empty). The public package ships with no organization-specific default.

### Workflow: writing a requirement document (common task)

See the full SOP: [`docs/workflow-requirement-doc.zh.md`](docs/workflow-requirement-doc.zh.md) — locate the directory (`outline_resolve_path`) → fetch the template (`outline_doc_template`) → draft → create with approval → verify.

## Security

Every write goes through native DSH approval and a per-deployment directory allow-list, and both fail closed: an unavailable approval service, an error inside the gate, or an unresolvable target path all refuse the write instead of performing it. Public instances must use HTTPS (loopback and private intranet hosts are exempt), API tokens stay in the DSH settings layer and never reach tool output, logs, or the browser half, and `outline_delete` asks for a second confirmation because it is irreversible. Local Markdown saves are confined to the configured save directory, with per-platform filename and path-length hardening.

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
