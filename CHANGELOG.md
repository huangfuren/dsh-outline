# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

## [Unreleased]

### Fixed — 已删除文档的读取不再被当成现行内容

实测确认 Outline 的 `documents.delete` 是软删除：`documents.info` 对已删文档仍返回 200（带 `deletedAt` 字段），
而 `documents.list` / `documents.search` 均不含已删文档。场景：模型拿着对话里缓存的旧 id 去读，
文档恰好刚被删 —— 读回的回收站内容会被当成现行内容，甚至被更新。
修复：`getDocument` 透传 `deletedAt`，渲染层头部标注「该文档已被删除（在回收站中），请勿更新或追加」。

## [v0.9.0] - 2026-10-29

### Added — Outline 新老版本兼容（v0.79 ~ v1.12+）

按 Outline 服务端 schema 源码逐版本核对（v0.79 / v0.83 / v1.0 / v1.5 / v1.9 / v1.12 / main），
把跨版本会变的三个参数面各自做成兼容实现，而不是绑在某一个版本的写法上。

| 能力 | v0.79 – v1.8 | v1.9 – v1.11 | v1.12+ |
| --- | --- | --- | --- |
| 追加正文 | `append: true` | `editMode: "append"` | `editMode: "append"` |
| 集合 / 作者过滤 | 顶层 `collectionId` / `userId` | 同左（已标弃用） | `filters` 数组，与旧参数**互斥** |
| 时间过滤 | 服务端不支持 | 服务端不支持 | `filters` + `updatedAt` + `gte` |

- **追加双发**：`updateDocument` 在 `append: true` 时同时发 `append` 与 `editMode: "append"`。
  老版本丢弃 `editMode` 用 `append`；新版本在 transform 里把 `append` 转成 `editMode` 后删除。
  只发其中一个都会在另一侧退化成**整篇覆盖**——这是最危险的失败模式，不报错、静默替换正文。
- **时间过滤探测**：`supportsFilters()` 用一次「未来时间点」的 `documents.list` 探测实例能力
  （支持则 `total=0`，不支持则 `filters` 被静默丢弃、返回真实总数；库为空时再取一次全库计数区分）。
  探测结果缓存在实例上，只有真要按时间过滤时才触发，普通搜索零额外请求。
- **探测失败语义**：只有服务端明确拒绝参数（400/422）才判为「不支持」；网络故障、鉴权失败一律向上抛，
  避免一次偶发失败被固化成本实例永久的能力误判。
- 返回结构新增 `timeFilterMode: "server" | "client"`，渲染层据此说明时间过滤是服务端做的还是本地补的。

### Added — 无关键词的时间检索改走 `documents.list`（精确，不再靠相关度猜）

上一轮修复后仍有一处语义缺口：空关键词 + `updatedAfter` 走的是 `documents.search`，而它按
**相关度**排序。实测扫 300 条候选只覆盖全库 0.7%（300/42714），拿到「300 篇候选里 94 篇是今天的」
之后，模型自己判断不可靠、转而逐集合补扫 —— 等于插件没把活干完。

在同一实例上实测确认了三件事：

| 探测项 | 结果 |
| --- | --- |
| `documents.list` 是否支持按更新时间排序 | **默认就是 `updatedAt` 降序**，与显式 `sort: 'updatedAt', direction: 'DESC'` 完全一致 |
| `offset` 分页 | 生效，相邻两页严格衔接、无重叠 |
| `sort` + `collectionId` | 兼容，同样降序 |

因此新增路径：**关键词为空时走 `documents.list` 降序扫描，遇到早于 `updatedAfter` 的文档即停**。
结果精确、请求数最小（实测一次请求取 100 条），不再受相关度排序影响。

- 返回新增 `timeFilterMode: 'list'`：表示这批结果按更新时间倒序取自 `documents.list`，不是关键词检索。
- 返回新增 `truncated`：为 `true` 表示达到单次上限、还有更早的符合条件的文档；渲染时给出可直接续取的
  `offset` 值，**不谎称「已取全」**；为 `false` 才表示已扫到时间边界/库末尾。
- 有关键词时仍走 `search`（相关度优先），其本地筛选的局限说明保留。
- `truncated` 的判定专门区分了「页内被 limit 截住」与「刚好读完最后一页」两种情况 —— 后者
  `offset` 会恰好等于 `total`，若据此判完整会把截断误报成完整。

### Fixed — 老实例上 `all: true` 的时间过滤退化成「只取第一页」

用真实老版本实例（42692 篇文档、`C1` 匹配 1128 篇）实测发现两个连锁缺陷，均只在
`timeFilterMode=client`（Outline 1.12 之前）时触发：

1. **翻页步长取错，`all: true` 静默失效**。第二页的 offset 取自 `first.hits.length`，
   而本地筛选下这是**筛后**条数（实测 100 条候选只留 6 条）。于是第二页从 `offset=6` 开始抓、
   与第一页完全重叠 → 新增命中恒为 0 → 撞上「无新增即到底」的保护而提前退出。
   实测 `all: true` 只发出 2 次请求、返回 6 条，与单页无异。
   - 修复：`OutlineSearchResult` 新增 `scannedCount`（本页服务端**原始**条数，仅 client 模式出现），
     翻页步长与进度判断改用它；`client` 模式下扫描窗口放宽到 `SEARCH_ALL_SCAN_MAX`（300），
     返回条数仍受 `SEARCH_ALL_MAX`（100）约束——上下文成本由命中数决定，不由扫描量决定。
   - 顺带修掉：第一页筛空不再直接收工（筛空只说明这一页候选里没有，不代表后面没有）。
2. **文案自相矛盾**。`total` 在本地筛选时是「筛前总数」，渲染层却拿它算「还有 N 篇未显示」。
   实测界面写成「找到 3 篇（共匹配 1128 篇）… 还有 1125 篇未显示」，而那 1125 篇全在时间范围之外，
   用户会以为还能翻出更多近期文档。
   - 修复：client 模式改为「已扫描 X 篇候选，其中 Y 篇在指定时间之后更新」，并明确
     `total` 是该关键词的全库匹配数、未按时间过滤；`all: true` 时状态同时透传（此前 `runQuery`
     聚合后丢失 `timeFilterMode`，渲染层根本进不了 client 分支）。

实测对照（`C1` + 近 7 天）：修复前命中 6 条、2 次请求后提前退出；修复后命中 12 条、扫描 300 篇候选。

### Fixed — `updatedAfter` 在真实 Outline 上从未生效

- **现象**：`outline_search` 的 `updatedAfter` 一直被当作请求体顶层参数发给服务端，但
  `DocumentsSearchSchema` 从来没有这个字段（v0.79 到 main 一致）。Outline 的 zod schema 没有
  `.strict()`，未知键被**静默 strip** → 过滤不生效、也不报错，工具却对外承诺「只返回此时间之后更新的文档」。
- **为什么测试没抓到**：`scripts/mock-outline-server.mjs` 自己实现了 `updatedAfter` 过滤，
  冒烟用例一直是绿的 —— 自建 mock 实现了服务端不存在的语义，等于给自己发了一张假绿卡。
  mock 已删除该实现，改为按实例能力分别模拟（`createMockOutlineServer({ filters: true })`）。
- **修复**：新实例走 `filters` + `updatedAt` + `gte`（`date` 类型在范围算子下同时接受绝对 ISO 日期与 ISO 时长）；
  老实例没有该能力，改为对取回的那一页按 `updatedAt` 本地筛选，并在结果里标注 `timeFilterMode: "client"`。
  `updatedAfter` 无法解析时直接报错，不再静默放行。

### Changed

- 新增冒烟断言：`filters` 实例下时间过滤走服务端、集合+作者+时间三条件同时生效；
  老实例下标注为 `client`。断言同时要求命中非空——`every()` 对空数组恒真，只看它会放过「过滤把结果全筛掉」的退化。

### Known issues

- `tests/settings.spec.ts` 继承 `SettingsProvider` 并用 `installSection` 做真实注册断言，
  但仓库依赖解析到的是 `@deepseek-ai/dsh-settings@0.1.5-rc.2`（peer 要求 cordis `^4.0.2`，实际装 4.0.1），
  验证的是 0.1.x 契约，覆盖不到 0.2.x。**运行期安全**：`src/index.ts` 对
  `typeof settings.installSection === 'function'` 有判断，缺失时退回 `settings.configure`。
- 该测试对 lockfile 的 peer 解析结果敏感：一旦同一份 lockfile 里出现多份 `dsh-settings` 变体
  （不同 cordis peer 组合），注册与查找会落到不同实例，表现为
  `settings namespace "outline-auto" is not registered`。这属于依赖图问题，不是代码缺陷；
  合并只改 lockfile 的依赖 PR 前应先确认 `dsh-settings` 仍只有单一变体。

## [v0.8.3] - 2026-10-16

### Fixed — 写路径审计（数据完整性 / 闸门强度 / 结果诚实性）

一次针对**写功能**的专项审计（含宿主 `dsh-tools` 0.2.0-rc.2 源码级契约核实与可执行探针复现），
修掉 5 类问题。**审批闸本身的行为经实测正确**（决策矩阵：读工具 allow；白名单内 create/update/delete
ask、白名单外与集合不可见 deny、空白名单全 deny），问题出在闸的**强度**与写路径的**护栏**上。

#### 1. 读→改→写会静默截断长文档（最严重）

- **现象**：`outline_get_document` 默认只返回前 20000 字符，而 `outline_update_document` 的 `text` 是
  **整体替换**且零护栏。模型走常规「读全文 → 改一处 → 写回」时，会把正文截掉一半。
  实测：原文 22757 字符 → 读回 20000 → 原样写回 → 服务端只剩 20000，**静默丢失 2757 字符**。
- **修复**：
  - 新增纯函数 `detectTruncatedRewrite()`：新正文是原文的**精确前缀**且丢失 ≥1000 字符，
    或长度恰为默认上限 20000 且原文更长 → 判定为截断写回。审批文案直接写明
    「原文 N 字符 → 写回 M 字符，将永久丢失 K 字符」并给出补救办法（`append: true` / 调大 `maxLength`）。
    判定为 `ask` 而非 `deny`（有意裁剪长文是合法诉求），但必须由用户带数据确认。
  - `outline_get_document` 的截断提示改为直接点明「不要把本结果交给 `outline_update_document` 写回」。
  - `outline_update_document` 新增 **`append`** 参数，透传 Outline 原生追加语义 —— 长文改动的安全路径。

#### 2. 未声明的写入参数被静默接受并静默丢弃

- **现象**：宿主 `parameterSchemaSpecToJsonSchema` 生成的参数 schema 不带
  `additionalProperties: false` —— 参数面**默认开放**（已用对照实验确认：`title: 123` 报
  `invalid arguments`，而未知键 `append` / `bogus` 无任何报错）。而 `updateDocument` 是白名单拼 payload，
  未知键被直接丢掉 → 模型传 `append: true` 以为在追加，实际拿到"成功"+整体覆盖。
- **修复**：三个写工具（`create` / `update` / `delete`）入口调用 `assertKnownWriteArgs()` 自查并拒绝未知键，
  报错里列出全部未知键与可用参数。纯函数、可单测。

#### 3. 审批闸可被短路（闸门强度）

- **现象**：闸挂在**可重排**的 `tools/pre-execute` waterfall 上。只要有任何一个先注册的监听器返回
  `{kind:'allow'}` 而不调用 `next()`，本插件的闸就根本不会执行 —— 在白名单已配置时写操作**零审批通过**。
- **修复**：注册宿主的**单调同步守卫** `ctx.tools.guard()` 作为地板。宿主只在决策为 `allow` 时查询守卫
  （`guardReason`），且任何监听器都无法把守卫的拒绝翻盘。只有真正走完本插件闸决策的 exec 才被记入
  `WeakSet`，未记入的写调用一律拒绝 —— 短路免疫；闸压根没装成（`gatePassed` 恒空）时同样是全拒的
  fail-closed 行为。

#### 4. `outline_delete` 的结果判定是 fail-open

- **现象**：原实现 `json.success !== false`，顶层没有 `success` 字段就兜底成成功。
  mock 实测响应形如 `{data:{success:true}}`（`success` 在内层）仍被判成功 ——
  这正是旧冒烟里「删除成功」断言能过的原因，**该断言并未验证服务端语义**。对"不可恢复"的操作，
  谎报成功比报失败危险得多。
- **修复**：改为要求**明确**的成功标记（兼容顶层 `{success:true}` / `{ok:true}` / `{data:{success:true}}`）；
  拿不到就抛错说明"删除请求已发出但无法确认"，让用户去 Outline 核对，绝不谎报已删除。
  mock 的响应层级同步修正为与真实实例一致（顶层成功标记），并新增"无成功标记"反例。

#### 5. 第二次删除确认未接入取消信号

- **现象**：宿主自己的 `serviceAsk` 会给 `approval.request` 传 `signal: exec.signal` 做协作式取消竞速，
  插件手写的第二次确认没传 → 用户在第二次弹窗期间取消本轮，该 promise 不会以 `cancelled` 收敛。
- **修复**：`DeleteApprovalRequester` 与 `index.ts` 接线一并透传 `exec.signal`。

#### 6. 复核追加：本地保存安全带可被 `..` 绕过、系统目录列表只覆盖 C 盘

一次对上述修正的独立复核（读 diff + 逐字节核对 `lib/` 产物 + 回宿主源码二次核实契约）发现两处
新引入的安全带缺口，一并修掉：

- **`checkSaveDir()` 只做文本比对**：`D:/saves/../..` 字面不以盘根结尾，却能绕过检查 ——
  随后的 `path.join` 由内核解析 `..`，实际落盘到盘根。现在先折叠 `.` / `..` / 重复斜杠，
  再对**折叠结果**做根目录与系统目录判定。
- **系统目录列表带 `c:` 盘符**：Windows 装在非 C 盘时（`D:\Windows`）整条列表失效。
  列表改为盘符无关（`/windows`、`/program files` …），判定前剥掉盘符，任何盘都生效。

复核同时确认了地板的**关键前提**成立：宿主 `dsh-tools` 0.2.0-rc.2 的 `prepareExecution` 中，
`waterfall("tools/pre-execute", exec, …)` 与 `guardReason(exec)` 收到的是 `createExecution()` 构造的
**同一个 exec 引用**（`tools-lib.js:3225` / `:3241`），因此 `WeakSet` 身份匹配有效；
且 `guardReason` **仅在 `decision.kind === "allow"` 时被查询**，"ask 时先打标记"不会放宽任何路径。
cordis `waterfall` 的 `next()` 语义（`(cbs.shift() ?? inner)(...args)`）也确认监听器返回而不调 `next()`
即终止链 —— 本闸的决策不会被后置监听器覆盖，而先注册的 `allow` 短路确实会让本闸不执行（正是地板所兜的场景）。

- 写工具 `execute` 兜底的集合归属读取改为 `getDocument(id, force=true)`，与审批闸同源，
  不再用 60s 缓存判定可写性（读工具继续走缓存）。
- 测试 204 → **210**（新增 `..` 折叠、非 C 盘系统目录、写工具 force 读取三组回归）。

### Changed — 写路径的其他修正

- **`published` 不再臆造**：实例未返回发布状态时，`OutlineCreateResult.published` 缺省（原实现盲填 `true`，
  会把草稿报成已发布）；create/update 的输出 schema 与渲染文案同步区分"已发布 / 草稿 / 服务端未返回"。
- **`outline_update_document` 支持 `publish`**：可显式发布或转为草稿（此前只能在创建时决定），
  update 的参数校验相应放宽为「至少需要 title / text / publish 之一」。
- **写入守卫的路径解析强制 fresh**：`getDocument(id, force)` / `resolveDocumentPath(id, force)` 新增 force，
  `resolvePathGuard` 一律传 `true`。白名单是**按名称前缀**匹配的，原先用 60s 文档缓存会让
  带外改名后的匹配结果滞后一个 TTL —— 等于拿可能过期的名字决定"这里可不可写"。读场景继续用缓存。
- **本地保存加安全带**：`checkSaveDir()` 拒绝磁盘根（`C:\`）、文件系统根（`/`）、共享根
  （`\\server\share`）与已知系统目录（`C:\Windows`、`C:\Program Files`、`/etc`、`/usr` 等）。
  明确标注是防呆而非沙箱。
- 文档：中英 README 补「写入与长文档」章节与「审批策略设为 never 时写操作全被拒绝（宿主 designed
  fail-closed，非插件故障）」说明。

### Added — 写路径测试覆盖（此前审批闸零测试）

- **新增 `tests/gate.spec.ts`（14 条）**：按宿主真实策略链还原 ——
  `waterfall("tools/pre-execute")` → ask 经批准变 allow → **仅 allow 时**查 `ctx.tools.guard()`
  —— 覆盖决策矩阵、只读模式、`publish`/`append` 文案、截断护栏文案（含确切字符数），
  以及**短路免疫**与**闸未安装时全拒**两个地板用例。
- **`scripts/smoke.mjs` 修掉"闸从未注册"的假覆盖**：此前 ctx 写死 `on: () => () => {}`，冒烟只走
  execute 层兜底。现在真实捕获并驱动 pre-execute 监听器与单调守卫，新增 9 项端到端断言
  （闸决策、短路后地板拒绝、未知参数拒绝、`append` 追加不覆盖原文、delete 无成功标记不谎报成功）。
- 单测 166 → **204**。

### Changed — 兼容区间

- `engines.dsh` 由 `>=0.1.5-rc.2 <0.2.0` 放宽为 `>=0.1.5-rc.2 <1.0.0`（`package.json` 与 `dsh.plugin.json` 同步），与其他插件一致；原上限只到 0.1.x，会在后续 0.2 版本不必要地禁用插件。

## [v0.8.2] - 2026-10-05

### Fixed — 桌面版（dsh 0.2.0-rc.2 profile）装不上：安装脚本触发 pnpm 构建审批

- **移除 `postinstall`**（`node scripts/repair-profile.mjs --quiet`）。桌面版「添加插件」走
  `pnpm add`，而 pnpm 10+ 默认不执行依赖的生命周期脚本，非交互场景下会把这一条报成
  `ERR_PNPM_IGNORED_BUILDS` 并中断安装：依赖能进 `node_modules`，但插件管理器判定失败、
  不写入 profile `package.json`，结果插件处于「装了一半」的状态（`node_modules` 有、
  `bundles` 没有）。桌面 profile 里还会留下 `pnpm-workspace.yaml` 的
  `allowBuilds: dsh-outline@…: set this to true or false` 待决项。该脚本只清理 0.8.0 之前的
  旧包名 `dsh-outline-ai`，对当前版本没有任何有效对象，因此直接移除而不是改成审批白名单。
- `scripts/repair-profile.mjs` 一并移出 `files`：不再随包分发，仓库内仅保留为可选的手动工具。
- 文档：「启动失败恢复」改为手工清理旧行 + 说明 `ERR_PNPM_IGNORED_BUILDS` 的成因；
  安装章节改为「本包不含安装生命周期脚本」。

### Changed — 客户端注入声明补齐

- `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-locale`。
  卡片运行期 `inject` 的是 `slots` / `locale` / `configForms` 三个服务，此前只声明了
  `dsh-client-ui-settings`（configForms 的提供方）与 `dsh-client-ui-settings-plugins`，
  依赖它们的传递顺序是隐式的。显式声明后模块图不再依赖宿主当前的 bundle 组合方式。

## [v0.8.1] - 2026-09-30

### Fixed — 设置页签「一片空白」的三处独立根因

- **导出 `Config`**：`lib/index.js` / `src/index.ts` 此前只 `import { Config } from './config.js'`
  而未 re-export。宿主用**插件模块的 `Config` 导出**作为该命名空间的 schema
  （`settings.describe()` 读 `entry.fiber.runtime.Config`），拿不到就整条命名空间不被投影，
  客户端卡片判 `available = false` 后 `return null` —— 页签因此空白。现已 `export { Config }`。
- **槽位注册补 `locale: NS`**：渲染器只对声明了字典命名空间的条目注入 `props.t`。
  此前注册 `settings.plugins.tab` 时未声明 `locale`，卡片里的 `t('cardTitle')` 抛
  `TypeError: t is not a function`，整张卡片被错误边界摘掉（浏览器控制台可见该报错）。
- **volatile 标记改为直接写 meta**：dsh 0.1.7 随附的 schemastery **3.18.1 没有 `.volatile()`**
  （实测 `typeof Schema.string().volatile === 'undefined'`）。原 shim「有就调用、没有就原样返回」
  等于没标，宿主 `volatileForm()` 收到 undefined 后跳过整个命名空间。现在两条路径都覆盖：
  有 `.volatile()`（0.2.x 随附版本）就调用；没有就写 `schema.meta.volatile = true` —— 宿主
  `volatileForm` / `isVolatilePath` 读的正是 `schema.meta.volatile`。
  注意不能用 `.set('meta', …)`，3.18.1 上会以 `Cannot set properties of undefined (setting 'meta')` 失败。

以上三条互相独立，缺任一条页签都会空；对 dsh 0.1.5 / 0.1.6 无影响（它们不读 volatile，且走 `installSection` 分支）。

### Added — P0 竞争力升级：自动证据注入

#### `outline_context_search` 工具（自动证据注入）
- **新增 `outline_context_search` 工具**：搜索知识库并直接返回命中文档的**摘要原文**（前 800 字正文），而非仅片段元数据。模型可一步获取可引用的内容原文，无需再手动调 `outline_get_document` 逐篇拉取。
- **OutlineClient 新增 `getDocumentExcerpt` / `searchWithExcerpts` 方法**：并发拉取命中文档摘要（上限 4 并发），复用 60s 文档缓存，避免重复打 API。
- **零命中回退**：多词查询零命中时自动用首词重试，与 `outline_search` 保持一致。

### Added — 面向 dsh 0.1.7-rc.2 的前向兼容

- **配置读取双形态**：新增 `readValue()`。dsh 0.1.7+ 对 volatile 字段递给插件的是 `Volatile<T>`（取值需 `.get()`），旧版本是普通值；`readValue()` 两种形态都能取到原始值，避免升级后 `config.baseUrl.trim()` 拿到包装对象而崩溃。全部 10 处配置读取点均已接入。
- **Config 字段按能力标记 volatile**：dsh 0.1.7+ 的设置页只收录标记了 volatile 的字段（宿主从 Config schema 自动生成卡片），本插件通过运行时特性探测调用 `.volatile()`；0.1.5 / 0.1.6 的 schemastery 无此方法，原样返回，行为完全不变。
- **`tests/config.spec.ts`**：新增 10 条护栏测试，覆盖普通值原样返回、`Volatile<T>` 解包、对象/数组不被误判、以及 Config schema 跨版本可构建。

### Changed

- 工具注册顺序调整：`outline_context_search` 排在 `outline_search` 之后，作为增强版搜索。
- **设置卡片注册改为按宿主能力选择**：不再无条件调用 `settings.installSection`。dsh ≤ 0.1.6 仍走 `installSection`（保持用户层覆盖能力）；dsh 0.1.7+ 该方法已被宿主移除，本插件检测到缺失时跳过安装、依赖宿主自动生成卡片，避免产生误导性的错误日志。读取宿主 settings 服务仍用直接属性访问（此前尝试改用 `ctx.get('settings')` 会让 smoke 桩取不到服务，已被 smoke 拦下并回退）。

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
