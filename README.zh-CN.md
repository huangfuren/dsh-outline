# dsh-outline

[English](./README.md)

DeepSeek Harness 的 Outline 插件：在对话中搜索、读取并在用户审批后创建、更新或删除文档。插件只连接用户配置的 Outline 实例，不携带任何组织内部地址、token、集合名或文档内容。

> 当前版本：0.8.0。支持的 DeepSeek Harness 基线为 `0.1.5-rc.2`（设置卡片依赖 `settings.installSection`），Node.js 需要 22.19 或更高版本；原生支持 Windows / macOS / Linux 三大平台，经过全量跨平台兼容性测试（152+ 单元测试）。

## 功能

- 搜索、读取、统计文档，并返回可点击的 Outline 链接；支持按作者姓名/邮箱过滤（服务端下推），命中附带作者名。
- `outline_context_search` 直接返回命中文档的**摘要原文**（正文前 800 字），可一步引用作答，不必再逐篇调 `outline_get_document`；摘要并发拉取（≤4）并复用 60s 文档缓存。
- 健壮性：429 限流自动重试（指数退避，最多 3 次）；公网地址强制 HTTPS（localhost 与内网私有地址除外）；读取缓存 TTL 可配置（`cacheTtlMs`，默认 60s）且带条目上限。
- 列出集合、解析“集合/目录/子目录”路径、列出直接子文档。
- 提供通用需求文档模板。
- 创建、更新和删除属于写操作，每次执行前需要用户审批；删除还需要第二次确认。
- 设置卡片位于 设置 -> 插件 -> 插件配置；插件状态位于 设置 -> 插件 -> 插件列表。
- 未配置 Outline 地址或 token 时，插件仍可启动，工具会返回配置提示。

## 安装

### 推荐：DSH 管理安装

从公开 GitHub 仓库安装，并固定到最新发布 tag：

```bash
dsh plugin --profile web add git+https://github.com/huangfuren/dsh-outline.git#v0.8.0
```

`#v0.8.0` 后缀固定到该发布版本；去掉后缀则跟随 `main` 分支最新提交。

安装后重启 `dsh web`。发布包已经包含编译后的 `lib/`，正常从 Git 安装时不依赖用户本地构建。安装钩子只会清理当前 DSH profile 中本插件旧名称 `dsh-outline-ai` 的残留引用，不会删除或改写其他插件。

交给 AI 安装时，只使用上面的 DSH 插件管理命令，不要再手动追加 `cordis.patch.yml` 或编辑 `dsh.profile.bundles`。如果启动错误指向其他插件，应单独修复或禁用错误中点名的插件。

本地 checkout 或解压后的目录可以使用：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-outline
```

分发压缩包必须包含 `package.json`、`lib/index.js`、`client.js`、`cordis.patch.yml` 和 `dsh.plugin.json`；构建前先执行：

```bash
pnpm build
```

### 旧版热安装脚本

`scripts/hot-install.mjs` 只建议用于本地开发。它会创建 profile 链接并追加 patch 行，公开分发不要把它作为标准安装方式。

### 启动失败恢复

```bash
dsh plugin --profile web why dsh-outline
```

如果报无法解析 `dsh-outline-ai`，说明 `%USERPROFILE%/.dsh/profiles/web/package.json` 或 profile 的 `cordis.patch.yml` 仍有旧名称。重新在受影响的 profile 中安装本包；启用包生命周期脚本时，安装钩子会自动迁移。如果安装时禁用了脚本，请执行：

```powershell
node node_modules/dsh-outline/scripts/repair-profile.mjs --profile-dir "$env:USERPROFILE/.dsh/profiles/web"
```

然后运行一次 DSH 插件管理命令刷新 profile lockfile，再重启 `dsh web`。不要把当前包名改回旧 id。

如果插件已加载但看不到卡片，重启 `dsh web`，先在插件列表确认 `dsh-outline`，再打开插件配置。宿主条目失败时不会注册 settings 命名空间。

## 配置

推荐在 设置 -> 插件 -> 插件配置 中填写：

| 字段 | 说明 |
| --- | --- |
| Service URL | Outline 实例根地址，例如 `https://outline.example.com` |
| API Token | 在 Outline 的 API keys 页面创建 |
| 可写目录（留空 = 只读） | 逗号分隔的目录路径，如 `集合A,集合B/目录1`；仅这些目录及其全部子级允许写入 |
| 同义词表（仅配置行） | 插件配置行 `synonyms`（YAML 映射，如 `synonyms: { 部署: [上线, 发布] }`）：搜索零命中时按"原词 → 首词 → 同义词"阶梯自动重试 |

也可以使用环境变量 `OUTLINE_BASE_URL` 和 `OUTLINE_API_TOKEN`，或在 `cordis.patch.yml` 的插件配置行中设置。公开包不得把内部集合名写入 schema 默认值、界面文案、测试数据或示例 URL。

**v0.3.0 默认只读**：未配置可写目录时，所有写工具（`outline_create` / `outline_update_document` / `outline_delete`）直接拒绝执行，连审批弹窗都不会出现。要允许写入，需列出可写的目录：`集合B/目录1` 覆盖该目录及其全部子级，单独的 `集合A` 覆盖整个集合。目标路径解析失败（集合不存在、目录不可见、文档被移动）一律拒绝——写入永远 fail-closed。

**从 0.2.x 升级**：0.3.0 用 `writablePaths` 白名单取代了 `protectedCollections` 黑名单。升级后**未配置可写目录前所有写入都会被拒绝**；之前用黑名单保护的集合，只需不把它列入 `writablePaths`（未列出 = 不可写）。请删除插件配置行里的 `protectedCollections`，并把 `writablePaths` 设为实际要写入的目录。

## 跨平台兼容性

本插件经过全面测试，**原生支持 Windows、macOS 和 Linux 三大平台**。所有关键代码路径均采用平台无关的实现模式，无需用户手动配置或额外适配。

### Windows 兼容性亮点

- ✅ **自动处理反斜杠输入习惯**：在「可写目录」和「路径解析」功能中，用户输入 `集合A\目录1`（使用 Windows 标准的反斜杠）会被自动归一化为 `集合A/目录1`，避免误判。
- ✅ **文件名安全化**：本地保存时自动替换文件系统非法字符（`\ / : * ? " < > |`），并保护 Windows 保留设备名（`CON`、`NUL`、`COM1-9`、`LPT1-9`）不被误用。
- ✅ **MAX_PATH 路径长度保护**：在 Windows 默认路径限制（260 字符）下，超长文档标题会被自动截断到安全长度（保留 `.md` 扩展名），确保不会因路径过长导致保存失败。
- ✅ **错误提示可操作**：文件系统错误（`ENOENT`、`EACCES`、`ENOSPC` 等）会翻译为用户可理解的中文提示，并根据平台给出针对性建议（例如 Windows 提示"路径过长"，macOS 提示"目录不存在"）。
- ✅ **环境变量回退链**：`$DSH_HOME` → `$USERPROFILE` → `$HOME` → 当前工作目录，自动适配 Windows 用户主目录位置。

### macOS / Linux 兼容性亮点

- ✅ **IPv6 回环地址支持**：`http://[::1]:3000` 形式的本地 IPv6 地址被正确识别为私有地址，不会误拒。
- ✅ **大小写不敏感文件系统**：APFS（macOS 默认）和 ext4（Linux 可选）的 case-insensitive 模式下，文件去重逻辑正确处理大小写差异，不会产生冲突。
- ✅ **LF/CRLF 行尾透明**：Markdown 内容始终使用 LF（`\n`），跨平台打开无显示异常。
- ✅ **UTF-8 Unicode 规范化**：支持 NFD（macOS）和 NFC（Windows/Linux）两种 Unicode 规范化形式的文件名，emoji 与 CJK 字符均可正常保存。
- ✅ **POSIX 路径限制**：macOS 和 Linux 的路径长度限制（通常 1024+ 字符）远高于 Windows，无需截断保护。

### 已知边界情况（非缺陷）

| 场景 | 行为 | 影响 |
|------|------|------|
| **macOS 大小写不敏感** | `Test.md` 与 `test.md` 被视为同一文件，去重时会生成 `test-2.md` | ✅ 设计如此，避免覆盖 |
| **Windows MAX_PATH 260** | 超长标题被自动截断到约 100-150 个中文字符 | ✅ 保护机制生效 |
| **Legacy 记事本** | Windows 10 之前的记事本打开 LF 文件显示异常 | ⚠️ 请使用 VS Code / Notepad++ |
| **iOS / Android** | 不支持（Node.js 22.19+ 无法在移动系统运行） | ⚠️ 请使用 macOS/Windows/Linux 桌面系统 |

---

## 兼容性与发布检查

- 使用 DSH `0.1.5-rc.2` 或更高的同一兼容范围测试；更早版本既没有 `settings.installSection`，也没有客户端注入兼容保证。
- 执行 `pnpm typecheck`、`pnpm build`、`pnpm test`（152 个单元测试，包含跨平台边界用例）和 `node scripts/smoke.mjs`（端到端集成测试）。
- 压缩包排除 `node_modules`、`.git`、settings 文件、token、内部地址和内部文档名称。
- 在干净的 `web` profile 中安装 GitHub 地址或压缩包，确认插件列表和插件配置两个入口都可见。
- 发布前搜索整个发布目录中的组织专属名称；检查失败就停止发布。

## 工具

`outline_search`、`outline_context_search`、`outline_get_document`、`outline_count`、`outline_list_collections`、`outline_list_users`、`outline_resolve_path`、`outline_list_children`、`outline_doc_template`、`outline_save_local`、`outline_create`、`outline_update_document` 和 `outline_delete`。

### 作者过滤（outline_list_users + outline_search 的 author）

- 想找"某人写的文档"时，先调 `outline_list_users` 拿到成员 id/姓名/邮箱。
- 或直接给 `outline_search` 传 `author=姓名/邮箱`：插件会先 `outline_list_users` 解析（精确唯一→直接用、多匹配→返回候选列表让你确认、无匹配→提示"未找到"），再把 `userId` **下推到 Outline 服务端过滤**——比盲搜后人工挑更高效、更省 token。
- 搜索命中会附带作者名（如 `（作者：张三）`，实例未返回或 users.list 不可用时缺省）。

### 检索效率与准确度（v0.7.0）

- **搜索缓存**：相同关键词（含过滤参数）短 TTL 缓存，同问不重打 API；增删改文档后自动失效。
- **`all=true` 抓全**：需要"列出全部相关文档"时让 AI 传 `all=true`，插件自动翻页（上限 100 篇）并跨页去重；服务端无视 offset 时自动停，不会死循环。
- **本地重排**：服务端排序基础上叠加——标题命中权重高于摘要命中，一年内更新的文档有新近度加成（同分保持服务端原序）。
- **零命中回退阶梯**：原词 → 首词（多词查询 AND 易落空）→ 同义词表变体（配置 `synonyms`），命中即停并标注实际生效词。
- **翻页提示**：结果未显示完时尾部提示可用 `offset` / `all` 继续获取。

### 本地保存（outline_save_local）

`search` / `get_document` 的结果末尾会多一段提示：**是否把本次输出整理成 Markdown 文件存到本地**，并给出实际存放目录。

- 默认目录：`$DSH_HOME/outline-auto-saves`（无 `DSH_HOME` 时回退 `$HOME/outline-auto-saves`）。
- 可在 **设置 → 插件 → 插件配置 → Outline 知识库** 卡片的「本地保存目录」中改成任意绝对路径（修改后需重启 web profile）。
- 用户在对话里回复"保存"后，AI 收集相关文档的 `id` 调用 `outline_save_local`（参数 `ids=文档id列表，逗号分隔`，最多 50 篇）：
  - 单篇 → 存为 `YYYY-MM-DD-标题.md`；
  - 多篇 → 合并为一个带目录的 Markdown（`首篇标题等N篇.md`）。
  - 同名文件自动追加序号 `-2`、`-3` … 不覆盖。
- 该能力只写本地磁盘，**不会**向 Outline 知识库写入任何内容。

## 安全

所有写操作都要经过 DSH 原生审批与按部署配置的可写目录白名单，两者均 fail-closed：审批服务不可用、闸门内部异常、目标路径无法解析，一律拒绝而不是放行。公开实例必须使用 HTTPS（本机回环与内网私网地址豁免），API token 只保存在 DSH 设置层，不会出现在工具返回值、日志或浏览器端；`outline_delete` 不可恢复，因此需要二次确认。本地 Markdown 落盘被限制在配置的保存目录内，并按平台做了文件名与路径长度加固。

完整的威胁模型与漏洞上报方式见 [SECURITY.md](./SECURITY.md)。

## 开发

```bash
pnpm typecheck
pnpm build
pnpm test
node scripts/smoke.mjs
```

真实 Outline 验证脚本需要环境变量 `OUTLINE_BASE_URL` 和 `OUTLINE_API_TOKEN`。token 只通过环境变量或用户本机 settings 传入，不要写入仓库。

## License

[MIT](./LICENSE)
