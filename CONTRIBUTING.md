# Contributing

Thank you for helping improve dsh-outline.

## Development setup

Requirements: Node.js 22.19 or newer, pnpm 9 (the version CI uses), and a compatible DeepSeek Harness installation.

```bash
pnpm install
pnpm run verify        # typecheck + vitest + smoke
```

Individual steps when you need them:

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | strict `tsc --noEmit` over `src/` |
| `pnpm build` | emit `lib/` (the published artifact) |
| `pnpm test` | unit tests with a mocked Outline API (success / empty / 401 / 403 / 404 / 429 / network / malformed response) |
| `node scripts/smoke.mjs` | end-to-end smoke against a local mock Outline server (prints `SMOKE PASS`) |
| `node scripts/verify.mjs` | real settings → search → count chain; add `--create` for the create + cleanup chain (needs `OUTLINE_BASE_URL` / `OUTLINE_API_TOKEN`) |

Use a local plugin link for manual testing:

```bash
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-outline
```

## Repository layout

- `src/` — TypeScript sources; the host logic and every tool lives here.
- `lib/` — build output, committed for distribution. Never edit by hand.
- `tests/` — unit tests mirroring `src/`.
- `scripts/` — smoke / verify / profile-repair helpers.
- `docs/` — long-form guides referenced by the READMEs.
- `client.js` — dependency-free single-file browser half, no build step.

## Pull requests

- Keep changes focused. Two independent changes belong in two pull requests.
- Add or update tests for behavioral changes; run the full `verify` chain.
- **Never** commit API tokens, Outline instance URLs, internal collection names, or real document content. Examples in code and docs must stay generic.
- Treat every change touching the write path as safety-sensitive: preserve approval, the `writablePaths` allow-list, and fail-closed behavior. The checks must stay in the host half — a UI-only restriction is not enough.
- Keep `lib/` in sync: if you change `src/`, run `pnpm build` and commit the regenerated `lib/`.
- Update **both** `README.md` and `README.zh-CN.md` when user-facing behavior changes, and add a `CHANGELOG.md` entry under `[Unreleased]`.
- Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `node scripts/smoke.mjs` and `npm pack --dry-run` before opening a pull request.

## Commit messages

Use Conventional Commits with a scope:

```
<type>(<scope>): <short summary>

<body: why the change was needed, what changed, what it affects>
```

- `type`: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `release`
- `scope`: the module or tool touched, e.g. `fix(search): …`, `feat(settings): …`, `fix(local-save): …`
- One logical change per commit; put detail in the body instead of stuffing the subject line.

**Releases are separate commits** (`release: v0.7.4`) — never mix a version bump or changelog reorganisation into a feature commit. Tags and GitHub Releases are created only through `deploy.sh`; ordinary pushes must not create them.

## Release process

Follow the "Release checklist" section in the README and run `./deploy.sh`. A failed check blocks the release: the tree must contain no organization-specific names, URLs, tokens, or document samples.
