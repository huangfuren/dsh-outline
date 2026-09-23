# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

## [Unreleased]

### Added — P0 竞争力升级：自动证据注入

#### `outline_context_search` 工具（自动证据注入）
- **新增 `outline_context_search` 工具**：搜索知识库并直接返回命中文档的**摘要原文**（前 800 字正文），而非仅片段元数据。模型可一步获取可引用的内容原文，无需再手动调 `outline_get_document` 逐篇拉取。
- **OutlineClient 新增 `getDocumentExcerpt` / `searchWithExcerpts` 方法**：并发拉取命中文档摘要（上限 4 并发），复用 60s 文档缓存，避免重复打 API。
- **零命中回退**：多词查询零命中时自动用首词重试，与 `outline_search` 保持一致。

### Changed

- 工具注册顺序调整：`outline_context_search` 排在 `outline_search` 之后，作为增强版搜索。

## [v0.8.0] - 2026-09-20

### Changed

- **Rename**: 包名与 GitHub 仓库 `dsh-outline-auto` → **`dsh-outline`**。`dsh.plugin.json` 的 id 随之变为 `dsh-external/dsh-outline`，宿主/客户端插件名与客户端 bundle id 同步为 `dsh-outline`。
  插件运行时实例 id（`outline-auto`、`outline-auto-skills`）**保持不变**，profile 里已有的配置（`baseUrl` / `apiToken` / 可写目录等）无需迁移。
- 安装地址更新为 `dsh plugin --profile web add git+https://github.com/huangfuren/dsh-outline.git#v0.8.0`；旧地址 `huangfuren/dsh-outline-auto` 会被 GitHub 自动重定向到新仓库。
- 备注：npm 上 `dsh-outline` 这个名字已被第三方包占用。本插件从未发布到 npm（一直走 GitHub 分发），现有安装方式不受影响；将来若要发 npm，需加 scope（例如 `@huangfuren/dsh-outline`）。

## [v0.7.4] - 2026-09-20

### Added

- **`SECURITY.md`** — 本插件自身的威胁模型：token 存放与传输、写审批与目录白名单的 fail-closed 行为、本地落盘的路径/文件名/长度加固、发布卫生要求，以及私有漏洞上报渠道。
- **`CONTRIBUTING.md`** — 开发环境、常用命令、仓库结构说明、PR 规则（含双语 README 同步与 lib/ 提交约定）、提交规范 `type(scope)` 与发布流程。

### Changed

- README 首屏不再复述版本发布说明（此前 v0.7.3 的发布详单同时占据中英两版首屏），版本差异一律由 CHANGELOG 承载。
- README 新增 **Security** 与 **Cross-platform compatibility** 章节，中英文保持对称。
- `@deepseek-ai/cordis` peerDependency 补上界（`>=4.0.0` → `>=4.0.0 <5`），与其余 peer 范围风格一致；`pnpm-lock.yaml` 同步更新，`pnpm install --frozen-lockfile` 校验通过。
- 发布包 `files` 清单纳入 `SECURITY.md`。

## [v0.7.3] - 2026-09-20

### Added — Cross-Platform Compatibility Enhancements

#### IPv6 & URL Security
- **IPv6 Support**: Bracketed IPv6 loopback addresses (`[::1]`) now correctly recognized as private addresses, no longer rejected by HTTPS enforcement.
- **Expanded Private Address Allowlist**: Added explicit detection of `0.0.0.0` alongside existing `localhost` / `127.0.0.1`.

#### Windows MAX_PATH Protection
- **Automatic Path Length Truncation**: When total file path exceeds Windows MAX_PATH=260 characters, filename is safely capped while preserving `.md` extension. No more "ENOENT" cryptic errors.
- **Platform-Specific Error Messages**: Filesystem errors translated into actionable Chinese hints per platform:
  - Windows: Shows "路径过长（MAX_PATH 限 260 字符）" when applicable
  - macOS/Linux: Shows standard path/permission guidance

#### Windows Input Habit Accommodation
- **Backslash Normalization**: Both `parseWritablePaths()` and `outline_resolve_path()` accept forward slash `/` AND backslash `\`, matching natural Windows user input patterns. Example: typing `集合 A\目录 1` works instead of forcing POSIX-style paths.

#### Filename Safety Enhancements
- **Windows Reserved Device Name Protection**: Names like `CON`, `NUL`, `COM1-9`, `LPT1-9` automatically appended with underscore (e.g., `CON.md`). Prevents silent file creation failures on Windows.
- **Leading/Trailing Dot & Space Handling**: Prevents silent trimming behavior that caused name mismatches on Windows (where `file.md.` becomes `file.md`).
- **De-duplication Retry Cap**: Maximum 51 attempts before falling back to timestamp suffix prevents infinite loops under edge cases (e.g., network share permission glitches).

### Improved — Error Translation & UX
- **Actionable Filesystem Hints**: EACCES, ENOSPC, EPERM errors now include both technical detail and user-facing suggestion depending on operating system.
- **Chinese Language Consistency**: All new error messages use simplified Chinese aligned with existing documentation tone.

### Testing Coverage Expansion

#### New Tests Added
- **15 Cross-Platform Boundary Cases**: IPv6 bracket handling, MAX_PATH length boundaries, case-insensitive filesystem behavior (NTFS/APFS), backslash normalization correctness, reserved device name protection logic, deduplication retry limits.
- **Real-world Path Length Validation**: Confirmed truncation behavior under typical Windows install paths (~100 chars) + long titles.
- **Platform Conditional Assertions**: Tests skip certain Windows-specific checks when running on POSIX systems, and vice versa.

#### Test Metrics
- **Total Tests**: 152 unit tests (up from 137 in v0.7.2).
- **Pass Rate**: 100% green across all test suites.
- **Coverage Areas**: Search tools, read/write guards, approval workflows, file saving, error translation.

### Documentation Updates

#### README Files
- Added detailed "Cross-Platform Compatibility" section describing per-platform features (Windows/macOS/Linux).
- Included table of known boundary conditions vs actual defects.
- Clarified iOS support status (not supported due to Node.js runtime requirement).

#### Version Alignment
- package.json: 0.7.3
- dsh.plugin.json: 0.7.3
- All references updated from v0.8.0 → v0.7.3.

### Notes

- **No breaking changes**: Existing configurations continue to work unchanged.
- **Enhanced resilience**: Better handling of edge-case environments (corporate proxies, NAS shares, special folder permissions).
- **Ready for distribution**: Verified through smoke tests, typecheck, and end-to-end integration tests.

---

## [v0.7.2] - 2026-09-16

### Fixed — 设置卡片在 dsh 0.1.5 下消失

- **根因**：宿主已移除自由函数 `installSettingsSection`，改由 `settings.installSection(owner, ns, schema, base, hooks)` 承担。插件此前按 vendored 的 `0.1.1-rc.2` 类型编写，`tsc` 通过但运行时走进降级分支，`outline-auto` 命名空间从未在宿主 settings 服务上注册 —— 于是 设置 → 插件 → 插件配置 没有卡片，只留下一行降级警告。
- **迁移**：改为 `ctx.inject(['settings'], (sctx) => sctx.settings.installSection(ctx, 'outline-auto', Config, base, hooks))`。同时删除"降级为 config-only"的兜底分支与告警文案：插件自本版本起硬依赖 dsh ≥ 0.1.5。
- **契约收紧**：`engines` 与四个 peer 范围统一到 `>=0.1.5-rc.2 <0.2.0`；`dsh.plugin.json` 的 `engines.dsh` 此前仍写 `0.1.1-rc.2`，与实际能力不符，一并修正。
- **顺带修复**：`skills-adapter.js` 因 peer `@deepseek-ai/dsh-skill-filesystem` 未解析而加载失败，peer 范围对齐后随 `pnpm install` 恢复。
- **回归防护**：新增 `tests/settings.spec.ts`（3 例）——在真实 `SettingsProvider`（内存子类）上启动插件，断言 ① `settings.describe()` 含 `outline-auto` 命名空间（卡片存在的前提）② 用户层覆盖经 `settings.update` 即时作用于 API 调用 ③ 未配置时报错指向 设置 → 插件 → 插件配置。既有两份测试从未走过 settings 接缝，这正是上次 breakage 能静默发布的原因。

### Verified — 0.1.5 接口逐项对账

- `tools.register(definition): () => void`、`tools/pre-execute` 的 `PreToolDecision`（`kind: 'allow' | 'deny' | 'ask'`）、`approval.request(req): ApprovalOutcome`（`'allowed-once'` 为唯一放行值）、`skill-filesystem` 的 `apply(ctx, config?)` 选项名（`providerName` / `includeDefaultRoots` / `bundledSkillDir` / `watch`）——除已修复的 settings 接缝外，无第二处不匹配。

## [v0.7.1] - 2026-09-14

### Added — 输出内容规范 skill

- **新增「输出内容规范」skill 提供者**：`skills/outline-answer-style/SKILL.md`，规范基于本包 `outline_*` 工具的回答排版（必附跳转链接、按主题分组、重复文档显式标注、末尾保存确认）。
- **独立加载、故障隔离**：skill 由 `skills-adapter.js` 承担，经 `cordis.patch.yml` 以单独一行 `outline-auto-skills` 挂载；该模块加载失败不会连带拖垮 `outline_*` 工具。
- **清单声明与依赖**：`dsh.plugin.json` 的 `contributes.skills` 声明 `outline-answer-style`；新增 peer 依赖 `@deepseek-ai/dsh-skill-filesystem`；打包 `files` / `exports` 纳入 `skills` 与 `skills-adapter.js`。

### Changed — 检索性能优化（结果集完全不变）
- **`all=true` 从「4 次串行分页」改为「一次抓满」**：按服务端单页上限（`limit=100`，超过会被 400 拒绝）单请求抓取，服务端只执行一次检索。同一实例实测 `LB` 5824ms → 3690ms、`迁移` 5392ms → 3655ms（约 **−35%**，4 轮交叉测量取中位）；命中集合与旧实现 **100/100 完全一致**，顺序差异仅来自既有的本地重排 `rerankHits`（已用 `rerankHits(旧结果) == 新结果` 逐条验证）。
- **实例上限更低时兜底并发分页**：若服务端把 `limit` 压小（返回短页），以实际页长为步长「顺序探测一页 + 余下页面并发（≤4）」补齐；保留「服务端无视 offset → 整页重复即停」的防死循环守卫，坏实例上仍只发 2 次请求。
- **集合 / 用户 / 子文档分页并发化**：`listCollections` / `listUsers` / `listChildDocuments` 由「逐页串行」改为「首页 + 余页并发（≤4）」，返回顺序与串行完全一致；大工作区（集合或用户 >100）下省掉 N−1 个 RTT。
- **新增并发闸门** `mapWithConcurrency`：统一把单次调用在飞请求数限制在 4 以内，避免瞬时打爆上游触发 429（重试反而更慢）。

### Fixed — 质量补全（零额外请求）
- **搜索结果作者名此前一直是空的**：旧实现从 `document.user` 取作者，而 Outline `documents.search` 实际返回的是 `document.createdBy`，导致 `authorName` 恒缺省；现直接取 `createdBy.name`（HTML 转义已剥离），实测 100/100 命中带作者名，且**不需要**额外拉一次 `users.list`（`document.user` + `users.list` 映射保留为兜底）。

## [v0.7.0] - 2026-09-08

### Changed (检索效率/准确度优化)
- **搜索结果短 TTL 缓存**：相同 query（含过滤/offset 归一化）在小时间窗内命中缓存，不重复打 Outline API；create/update/delete 后自动失效。
- **`all=true` 自动翻页**：跨页按文档 id 去重合并，上限 100 篇；内置"服务端无视 offset（整页重复）"的防死循环守卫，适合"列出全部相关文档"。
- **零命中回退阶梯**：原词 → 首词（多词查询 AND 易落空）→ 同义词表变体，命中即停并标注实际生效词。
- **本地轻量重排**：服务端排序上叠加"标题命中 > 摘要命中 + 一年内新近度加成"（同分保持原序，纯函数可测）。
- **同义词/别名表（新配置项 `synonyms`）**：`{ 部署: [上线, 发布] }` 形式的 YAML 映射，设置用户层或插件配置行均可（配置行需重启生效）；未配置 = 回退阶梯只含首词。
- **翻页提示**：结果尾部在仍有更多未显示时提示用户用 `offset` / `all` 继续获取。

## [v0.6.0] - 2026-09-08

### Added
- **作者过滤（outline_list_users + outline_search.author）**：新增 `outline_list_users` 列出工作区成员（id/姓名/邮箱）；`outline_search` 新增 `author` 参数（姓名/邮箱），先经 `users.list` 解析（精确唯一→直用、多匹配→返回候选、无匹配→提示未找到），再把 `userId` 下推到 Outline 服务端过滤，比盲搜后人工挑更高效、更省 token。搜索命中附带作者名（`authorName`，实例未返回或 users.list 不可用时缺省）。
- **outline_save_local 批量保存闭环**：移除 `source` 单模限制，改为 `ids` 逗号分隔文档 id 列表（最多 50 篇），把一篇或多篇 Outline 文档整理成本地 Markdown（单篇用其标题、多篇合并为带目录的一个文件 `首篇标题等N篇.md`），同名自动 `-2` 序号不覆盖。配合 search/get_document 末尾提示，真正闭环"把本次结果存到本地"。

### Changed
- `outline_search` 的 `userId` 过滤保留为精确入口；新增更友好的 `author`（姓名/邮箱）入口。

## [v0.5.0] - 2026-09-08

### Added

- **本地保存（`outline_save_local`）**：`outline_search` 与 `outline_get_document` 的结果末尾追加「是否整理成文档存到本地」提示并给出实际存放目录；用户确认后由 `outline_save_local` 把指定 Outline 文档写成本地 Markdown（`YYYY-MM-DD-标题.md`，同名自动 `-2` 序号，不覆盖）。只写本地磁盘，不向知识库写入。
- **配置项 `localSaveDir`**（GUI 卡片「本地保存目录」+ 插件配置行 + 环境变量）：留空默认 `$DSH_HOME/outline-auto-saves`（无 `DSH_HOME` 回退 `$HOME/outline-auto-saves`）。

## [v0.4.2] - 2026-09-08

### Fixed

- **`updateDocument` 缓存失效补全**：更新文档后同步清集合缓存，避免文档数与缓存不符。
- **search snippet 保留原始上下文**：不再对 snippet 调用 `stripHtml`，Outline 返回的高亮标签（`<b>`、`&nbsp;` 等）完整传给聊天渲染层。
- **`update_document` 参数校验前置**：`title` 和 `text` 均为空时 pre-execute 直接 deny，不再走完路径解析再报错；execute 内保留 fail-closed 兜底。
- **mock server 过滤支持**：`documents.search` 端点补全 `userId` / `updatedAfter` / `collectionId` 过滤逻辑，smoke 可验证。

## [v0.7.4] - 2026-09-20

### Added

- Placeholder for the next release.

## [v0.4.1] - 2026-09-04

### Changed

- **DSH 版本兼容性加固**（host + client）：
  - `ctx.tools` 缺失时显式 warn，工具注册全部跳过而非静默崩溃
  - `installSettingsSection` 抛错时回退 config-only 模式（搜索/读取工具仍可用）
  - `approval` 服务加 `approval.request` 形状检查 + try/catch；抛错时 fail-closed 拒绝 delete
  - `ctx.on('tools/pre-execute', ...)` 整体用 `typeof ctx.on === 'function'` 守卫；回调入口 try/catch，DSH 改事件签名时 fail-closed deny
  - client 端拆 `apply()` 为 `tryActivate() + apply()`，缺 `slots/locale/settingsScope` 任一服务显式 warn
  - client 监听 cordis `service-added` 事件，DSH 启动顺序变化时保证最终激活
  - CSS 注入加 `data-plugin-css` 属性，兼容 DSH 头部清理策略变更

## [v0.4.0] - 2026-08-30

### Added

- **429 限流自动重试**：请求被限流时按 `Retry-After` 或指数退避自动重试（最多 3 次），重试后仍失败才报错。
- **HTTPS 校验**：公网地址必须使用 `https://`（localhost 与内网私有地址除外），避免 Token 明文传输。
- **可配置缓存 TTL**：新增 `cacheTtlMs` 配置（默认 60000，范围 1000–300000），文档与集合缓存有效期可调；文档缓存增加条目上限（200 条，超限淘汰最旧），防止长时间运行内存膨胀。

## [v0.3.1] - 2026-08-30

### Fixed

- **分页补齐**：`outline_list_collections` 与 `outline_list_children` 改为循环翻页直到收齐 `pagination.total`，不再因单页上限（100 条）漏集合或漏子文档。
- **搜索翻页**：`outline_search` 新增 `offset` 参数，可配合 `limit` 翻页查看更多结果。
- **写后缓存失效**：`outline_create` / `outline_update_document` / `outline_delete` 执行成功后主动清除对应文档缓存与集合缓存，避免 60s 缓存窗口内读到旧内容。

## [v0.3.0] - 2026-08-30

### Added

- **Writable-path allow-list with read-only default** (`writablePaths`): comma-separated directory paths (`Collection A` or `Collection A/Dir 1/Sub`); only those directories and their children may be written. With no paths configured the plugin is read-only and every write tool refuses to run — no approval prompt is even shown.
- `parseWritablePaths` / `resolvePathGuard`: prefix-matched, fail-closed directory guard (missing collection, unresolvable path, or out-of-whitelist target all refuse the write).
- Settings card reworked to match the house style: per-field status badges (Configured/Not configured; Writable/Read-only), API token masked with stars (never echoed back in plaintext), a Remove button per configured field (confirmation then immediate clear), a saved confirmation line, and a collapsed-card header badge.
- Plugin settings card ordering fix: the `settings.plugin.item` keyed slot sorts by `priority` (registration order), so the card registers with `priority: -1` to stay on top.

### Changed

- **Breaking**: the deny-list (`protectedCollections` / `FORBIDDEN_WRITE_COLLECTIONS`) is replaced by the `writablePaths` allow-list. After upgrading, every write is refused until writable paths are configured; a collection that is not listed is not writable.
- The settings `base` layer now merges the plugin config row and environment variables (env wins over the config row), so the client card sees deployment-provided connection info and reports "Configured" accordingly.

### Removed

- `protectedCollections` config field, `FORBIDDEN_WRITE_COLLECTIONS`, and the name-based deny-list guard.

### Security

- Read-only by default: with an empty whitelist, all write operations are refused before any approval prompt.
- API token is masked in the settings card and never displayed as plaintext.

### Fixed

- Organization-specific names scrubbed from source, tests, docs, and READMEs (public package ships with no deployment defaults).
