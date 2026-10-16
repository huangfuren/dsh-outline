import { Config, readValue } from './config.js';
// 必须 re-export：宿主用插件模块的 `Config` 导出作为该命名空间的 schema
// （settings 的 describe() 读 `entry.fiber.runtime.Config`）。只 import 不导出会让
// volatileForm() 收到 undefined → 整条命名空间不投影 → 客户端卡片判 available=false
// 后 return null，表现为「内置插件」里该页签一片空白。
export { Config };
import { OutlineClient } from './client.js';
import { outlineSearchTool, outlineGetDocumentTool, outlineCountTool, outlineListCollectionsTool, outlineResolvePathTool, outlineCreateTool, outlineUpdateDocumentTool, outlineDeleteTool, outlineListChildrenTool, outlineDocTemplateTool, outlineSaveLocalTool, outlineListUsersTool, outlineContextSearchTool, buildCreateApprovalReason, resolveWriteGuard, parseWritablePaths, resolvePathGuard, resolveLocalSaveDir, detectTruncatedRewrite, } from './tools.js';
export const name = 'dsh-outline';
export const inject = ['tools'];
/** GUI 设置命名空间（设置 → 插件 → 插件配置 的卡片读写它，持久化在 settings.yaml）。 */
const SETTINGS_NS = 'outline-auto';
/** 兼容性日志：优先宿主 logger，缺失时退回 console；日志本身绝不抛异常。 */
function report(ctx, message, error) {
    const detail = error === undefined || error === null
        ? ''
        : ': ' + (error instanceof Error ? error.message : String(error));
    const text = '[outline-auto] ' + message + detail;
    try {
        // 用 ctx.get 探测 logger：cordis 对未声明的属性直访会抛守卫异常，get 不会。
        const get = ctx.get;
        const logger = get('logger');
        if (logger !== undefined && logger !== null && typeof logger.warn === 'function')
            logger.warn(text);
        else
            console.warn(text);
    }
    catch {
        try {
            console.warn(text);
        }
        catch { /* 日志失败不影响插件 */ }
    }
}
export function apply(ctx, config = {}) {
    // 连接配置优先级（与 README 一致）：GUI 卡片（settings.yaml 用户层）→ 环境变量 → 插件配置行。
    // settings 注册时 base 传空对象，使解析值只反映 GUI 用户层，环境变量与配置行在下方回退。
    let settingsSource = () => ({});
    // 客户端复用：同一配置（baseUrl/apiToken/timeoutMs）复用同一 OutlineClient 实例，
    // 使其 60s 文档缓存跨工具调用生效（与 README 承诺一致）；配置变更后按 key 自动重建。
    let cachedClient = null;
    const makeClient = () => {
        const s = settingsSource();
        // readValue：dsh 0.1.7+ 的 volatile 字段以 Volatile<T> 递入，需 .get() 取出原值。
        const baseUrl = (s.baseUrl ?? '').trim()
            || (process.env.OUTLINE_BASE_URL ?? '').trim()
            || (readValue(config.baseUrl) ?? '').trim();
        const apiToken = (s.apiToken ?? '').trim()
            || (process.env.OUTLINE_API_TOKEN ?? '').trim()
            || (readValue(config.apiToken) ?? '').trim();
        if (!baseUrl || !apiToken) {
            throw new Error('dsh-outline 未配置：需要 baseUrl 与 apiToken（可在 设置 → 插件 → 插件配置 填写，或环境变量 OUTLINE_BASE_URL / OUTLINE_API_TOKEN）。配置方法见插件 README。');
        }
        const timeoutMs = readValue(config.timeoutMs) ?? 15000;
        const cacheTtlMs = readValue(config.cacheTtlMs) ?? 60000;
        const key = `${baseUrl}\u0000${apiToken}\u0000${timeoutMs}\u0000${cacheTtlMs}`;
        if (cachedClient !== null && cachedClient.key === key)
            return cachedClient.client;
        const client = new OutlineClient({ baseUrl, apiToken, timeoutMs, cacheTtlMs });
        cachedClient = { key, client };
        return client;
    };
    // 可写目录白名单：settings 用户层 → 插件配置 → 默认空（只读模式）。
    const getWritablePaths = () => {
        const s = settingsSource();
        return (s.writablePaths ?? readValue(config.writablePaths) ?? '').trim();
    };
    // 本地保存目录：settings 用户层 → 插件配置 → 默认 DSH_HOME/outline-auto-saves → 回退 HOME。
    const getLocalSaveDir = () => {
        const s = settingsSource();
        return resolveLocalSaveDir(s.localSaveDir ?? readValue(config.localSaveDir));
    };
    // settings 的 base 层 = 插件配置行 + 环境变量（env 优先于配置行）。
    // 这样用户层未覆盖时解析值仍含部署连接信息，客户端卡片据此显示“已配置”，
    // 且卡片字段能回显部署默认值（apiToken 由客户端掩码，不回显明文）。
    const settingsBase = {
        ...config,
        ...(config.baseUrl === undefined || config.baseUrl === ''
            ? (process.env.OUTLINE_BASE_URL ? { baseUrl: process.env.OUTLINE_BASE_URL } : {})
            : {}),
        ...(config.apiToken === undefined || config.apiToken === ''
            ? (process.env.OUTLINE_API_TOKEN ? { apiToken: process.env.OUTLINE_API_TOKEN } : {})
            : {}),
    };
    // 设置卡片注册：两条宿主路径按能力自动选择，不做版本嗅探。
    // - dsh <= 0.1.6：需显式 installSection 发布命名空间/schema，并用 setSource 接住用户层覆盖。
    // - dsh >= 0.1.7：宿主从插件声明的 Config schema 直接生成卡片，installSection 已被移除；
    //   0.2.0 起服务是 SettingsForms（configure/describe/update/...），用户层覆盖由宿主
    //   合并进 apply 的 config 本身，settingsSource 不再需要接。
    try {
        ctx.inject(['settings'], (sctx) => {
            try {
                // 直接访问宿主注入的 settings 服务（与 dsh <= 0.1.6 的写法一致）；
                // cordis 的守卫异常若发生，由下面的 catch 兜住。
                const settings = sctx.settings;
                if (settings === undefined || settings === null) {
                    report(ctx, 'settings service unavailable; GUI card will not persist config');
                    return;
                }
                if (typeof settings.installSection === 'function') {
                    settings.installSection(ctx, SETTINGS_NS, Config, settingsBase, {
                        setSource: (current) => {
                            settingsSource = current;
                        },
                        onChange: () => { },
                    });
                    return;
                }
                if (typeof settings.configure === 'function') {
                    // 声明「允许宿主自动生成卡片」；用户层由宿主写回 config，settingsSource 保持空。
                    sctx.effect(() => settings.configure({ auto: true }), 'outline-auto: settings page policy');
                }
            }
            catch (err) {
                report(ctx, 'settings section unavailable; GUI card will not persist config', err);
            }
        });
    }
    catch (err) {
        report(ctx, 'settings injection unavailable; GUI card will not persist config', err);
    }
    // 同义词/别名表：settings 用户层 → 插件配置行 → 空（关闭回退）。
    const getSynonyms = () => {
        const s = settingsSource();
        return s.synonyms ?? readValue(config.synonyms) ?? {};
    };
    // 兼容性加固：逐个工具独立注册并各自 try/catch。宿主升级若改动了工具注册
    // API 或某个工具的工厂签名，只降级该工具并打日志，其余工具照常可用，
    // 且绝不向外抛异常（apply 抛异常会让 DSH 拒绝启动整个插件树）。
    const tools = ctx.tools;
    if (tools === undefined || typeof tools.register !== 'function') {
        report(ctx, 'tools.register API changed; Outline tools not registered');
        return;
    }
    const toolFactories = [
        ['outline_search', () => outlineSearchTool(makeClient, readValue(config.searchLimit) ?? 10, getLocalSaveDir, getSynonyms)],
        ['outline_context_search', () => outlineContextSearchTool(makeClient, readValue(config.searchLimit) ?? 10)],
        ['outline_get_document', () => outlineGetDocumentTool(makeClient, getLocalSaveDir)],
        ['outline_count', () => outlineCountTool(makeClient)],
        ['outline_list_collections', () => outlineListCollectionsTool(makeClient)],
        ['outline_list_users', () => outlineListUsersTool(makeClient)],
        ['outline_resolve_path', () => outlineResolvePathTool(makeClient)],
        ['outline_list_children', () => outlineListChildrenTool(makeClient)],
        ['outline_doc_template', () => outlineDocTemplateTool()],
        ['outline_save_local', () => outlineSaveLocalTool(getLocalSaveDir, makeClient)],
        ['outline_create', () => outlineCreateTool(makeClient, getWritablePaths)],
        ['outline_update_document', () => outlineUpdateDocumentTool(makeClient, getWritablePaths)],
        ['outline_delete', () => outlineDeleteTool(makeClient, getWritablePaths, async (reason, exec) => {
                const approval = ctx.get('approval');
                if (approval === undefined)
                    return false;
                const outcome = await approval.request({
                    agent: exec.agent,
                    toolName: 'outline_delete',
                    callId: exec.callId,
                    reason,
                    // 与宿主 serviceAsk 一致地透传 exec.signal：用户在第二次弹窗期间取消本轮时，
                    // approval.decide() 会以 'cancelled' 收敛，而不是让这里挂到弹窗自己返回为止。
                    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
                });
                return outcome === 'allowed-once';
            })],
    ];
    for (const [label, factory] of toolFactories) {
        try {
            tools.register(factory());
        }
        catch (err) {
            report(ctx, `tool "${label}" was not registered`, err);
        }
    }
    // 写工具审批闸：create/update/delete 需用户确认；目录白名单或权限不满足时直接拒绝（连审批都不弹）。
    // 兼容性加固：闸门自身任何异常都按 fail-closed 处理（一律拒绝写操作），
    // 绝不因宿主 API 变化而放行写入；读工具不受影响。
    //
    // 单调地板（gatePassed + ctx.tools.guard）：
    // `tools/pre-execute` 是**可重排的 waterfall** —— 只要有任何一个先注册的监听器（别的插件、
    // 宿主预置策略）返回 `{kind:'allow'}` 而不调用 `next()`，本插件的闸就根本不会执行，写操作会在
    // 「白名单已配置所以守卫放行」的情况下**零审批通过**。宿主为此专门提供了单调同步守卫
    // `ctx.tools.guard()`：它在 waterfall **之后**运行，返回的理由只能拒绝、任何后续监听器都无法翻盘
    // （dsh-tools 的 `guardReason` 仅在 `decision.kind === 'allow'` 时被查询）。
    // 因此：只有真正走完本插件闸决策的 exec 才被记入 `gatePassed`，未记入的写调用一律拒绝 ——
    // 即使闸被短路、甚至闸压根没装成（此时 gatePassed 恒为空），也仍然 fail-closed。
    const gatePassed = new WeakSet();
    const WRITE_TOOL_NAMES = new Set(['outline_create', 'outline_update_document', 'outline_delete']);
    if (typeof tools.guard === 'function') {
        try {
            tools.guard((exec) => {
                const toolName = exec?.name;
                if (toolName === undefined || !WRITE_TOOL_NAMES.has(toolName))
                    return undefined;
                if (gatePassed.has(exec))
                    return undefined;
                return `写操作未经 dsh-outline 的审批闸，已拒绝（${toolName}）。`
                    + '这通常意味着审批闸未生效：宿主事件契约变化、或他方监听器短路了 tools/pre-execute。'
                    + '请查看插件日志（[outline-auto] ...）确认闸是否安装成功；如需临时放行，请升级/修复插件而不是绕过闸。';
            });
        }
        catch (err) {
            report(ctx, 'ctx.tools.guard unavailable; write-approval floor not installed (waterfall gate still active)', err);
        }
    }
    else {
        report(ctx, 'ctx.tools.guard missing; write-approval floor not installed (waterfall gate still active)');
    }
    if (typeof ctx.on !== 'function') {
        // 闸装不上 → gatePassed 恒为空 → 上面的地板会拒绝全部写操作（fail-closed）。
        report(ctx, 'ctx.on unavailable; Outline write-approval gate not installed; all writes will be denied');
        return;
    }
    try {
        ctx.on('tools/pre-execute', async (exec, next) => {
            const name = exec.name;
            if (name !== 'outline_create' && name !== 'outline_update_document' && name !== 'outline_delete') {
                return next();
            }
            /**
             * 走完守卫链、准备交由用户审批：先把该次 exec 记入 gatePassed，地板才允许它继续。
             * 标记在 ask 时完成即可 —— 用户否决时宿主走的是 deny 分支，地板根本不会被查询
             * （guardReason 只在决策为 allow 时执行），所以"先标记再审批"不会放宽任何东西。
             */
            const askAfterGate = (reason) => {
                gatePassed.add(exec);
                return { kind: 'ask', reason };
            };
            try {
                const args = (exec.arguments ?? {});
                const client = makeClient();
                // ① 目录白名单校验（fail-closed；空白名单 = 只读模式，直接拒绝）
                let collections = [];
                try {
                    collections = await client.listCollections();
                }
                catch {
                    // collections 为空 → resolveWriteGuard fails closed when it cannot verify the target
                }
                const pathGuard = await (async () => {
                    try {
                        if (name === 'outline_create') {
                            const a = args;
                            return await resolvePathGuard(client, { kind: 'create', collectionId: a.collectionId ?? '', parentDocumentId: a.parentDocumentId }, parseWritablePaths(getWritablePaths()), collections);
                        }
                        return await resolvePathGuard(client, { kind: 'doc', docId: args.id ?? '' }, parseWritablePaths(getWritablePaths()), collections);
                    }
                    catch {
                        return '无法解析写入目标路径：目标集合或文档不可见。为避免误写，本次操作已拒绝。';
                    }
                })();
                if (pathGuard !== null)
                    return { kind: 'deny', reason: pathGuard };
                // ② 集合存在与 token 权限（顺带缓存目标文档，供 ③ 的截断护栏复用，零额外请求）
                let collectionId;
                let targetDoc;
                try {
                    if (name === 'outline_create') {
                        collectionId = args.collectionId;
                    }
                    else {
                        // force=true：写决策不能建立在 60s 前的读上（截断比对与集合归属都要当下的事实）
                        targetDoc = await client.getDocument(args.id ?? '', true);
                        collectionId = targetDoc.collectionId;
                    }
                }
                catch {
                    // resolveWriteGuard deliberately denies an unverifiable target.
                }
                const guard = resolveWriteGuard(collections, collectionId ?? '');
                if (guard !== null)
                    return { kind: 'deny', reason: guard };
                // ③ 审批
                if (name === 'outline_create') {
                    const a = args;
                    let collectionName;
                    let resolvedPath;
                    collectionName = collections.find((c) => c.id === a.collectionId)?.name;
                    if (a.parentDocumentId !== undefined && a.parentDocumentId !== '') {
                        try {
                            resolvedPath = await client.resolveDocumentPath(a.parentDocumentId);
                        }
                        catch {
                            resolvedPath = undefined;
                        }
                    }
                    return askAfterGate(buildCreateApprovalReason(a, collectionName, resolvedPath));
                }
                // 参数校验前置：update 至少需要 title / text / publish 之一（在路径解析前拦截，避免无意义 API 调用）
                if (name === 'outline_update_document') {
                    const a = args;
                    if ((a.title === undefined || a.title === '')
                        && (a.text === undefined || a.text === '')
                        && a.publish === undefined) {
                        return { kind: 'deny', reason: 'outline_update_document 至少需要 title / text / publish 之一' };
                    }
                    // 截断护栏：text 是整体替换。若新正文是"读取时被截断的原文"（精确前缀 / 恰为默认上限），
                    // 写回会永久丢失被截掉的部分。这里用已取到的 targetDoc 全文比对（零额外请求），
                    // 命中则把确切字符数写进审批文案，由用户带数据决定 —— 判定为 ask 而非 deny，
                    // 因为"有意裁剪长文"是合法诉求。
                    const truncationWarning = a.text !== undefined && a.append !== true && targetDoc !== undefined
                        ? detectTruncatedRewrite(targetDoc.text, a.text)
                        : null;
                    if (truncationWarning !== null) {
                        let warnPath;
                        try {
                            warnPath = await client.resolveDocumentPath(a.id ?? '');
                        }
                        catch {
                            // 路径解析失败不影响告警本身
                        }
                        const warnWhere = warnPath !== undefined && warnPath.length > 0 ? `路径：${warnPath.join(' / ')}` : `文档 id：${a.id ?? ''}`;
                        return askAfterGate(`将更新 Outline 文档：\n${warnWhere}\n变更：改正文（整体替换）\n\n${truncationWarning}`);
                    }
                }
                let docPath;
                try {
                    docPath = await client.resolveDocumentPath(args.id ?? '');
                }
                catch {
                    // 解析失败仍继续走 ask（reason 里看不到路径也至少让用户确认操作）
                }
                const where = docPath !== undefined && docPath.length > 0 ? `路径：${docPath.join(' / ')}` : `文档 id：${args.id ?? ''}`;
                if (name === 'outline_update_document') {
                    const a = args;
                    const changes = [
                        a.title !== undefined && a.title !== '' ? '改标题' : '',
                        a.text !== undefined && a.text !== '' ? (a.append === true ? '追加正文' : '改正文（整体替换）') : '',
                        a.publish === true ? '发布（取消草稿）' : (a.publish === false ? '转为草稿' : ''),
                    ].filter(Boolean).join(' + ');
                    return askAfterGate(`将更新 Outline 文档：\n${where}\n变更：${changes}`);
                }
                return askAfterGate(`将删除 Outline 文档（第 1 次确认）：\n${where}`);
            }
            catch (err) {
                report(ctx, `write-approval gate failed for "${name}"; the write was denied`, err);
                return {
                    kind: 'deny',
                    reason: '写入审批闸内部错误，为安全起见本次写操作已拒绝。'
                        + (err instanceof Error && err.message ? '（' + err.message + '）' : ''),
                };
            }
        });
    }
    catch (err) {
        report(ctx, 'ctx.on("tools/pre-execute") failed; write-approval gate not installed', err);
    }
}
