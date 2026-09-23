import type { Context } from '@deepseek-ai/cordis'
// 仅需类型增强：ctx.settings（SettingsProvider）与 ctx.approval（ApprovalService）挂在 Context 上。
// 运行时不 import 这两个包的任何导出——宿主进程提供实现，插件只通过注入的服务对象调用。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import { Config } from './config.js'
import { OutlineClient } from './client.js'
import {
  outlineSearchTool, outlineGetDocumentTool, outlineCountTool, outlineListCollectionsTool,
  outlineResolvePathTool, outlineCreateTool, outlineUpdateDocumentTool, outlineDeleteTool,
  outlineListChildrenTool, outlineDocTemplateTool, outlineSaveLocalTool, outlineListUsersTool,
  outlineContextSearchTool,
  buildCreateApprovalReason, resolveWriteGuard,
  parseWritablePaths, resolvePathGuard, resolveLocalSaveDir,
} from './tools.js'
import type { OutlineCollection } from './client.js'

export const name = 'dsh-outline'
export const inject = ['tools']

/** GUI 设置命名空间（设置 → 插件 → 插件配置 的卡片读写它，持久化在 settings.yaml）。 */
const SETTINGS_NS = 'outline-auto'

/** 兼容性日志：优先宿主 logger，缺失时退回 console；日志本身绝不抛异常。 */
function report(ctx: Context, message: string, error?: unknown): void {
  const detail = error === undefined || error === null
    ? ''
    : ': ' + (error instanceof Error ? error.message : String(error))
  const text = '[outline-auto] ' + message + detail
  try {
    // 用 ctx.get 探测 logger：cordis 对未声明的属性直访会抛守卫异常，get 不会。
    const get = ctx.get as (name: string) => unknown
    const logger = get('logger') as { warn?: (text: string) => void } | undefined
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') logger.warn(text)
    else console.warn(text)
  } catch {
    try { console.warn(text) } catch { /* 日志失败不影响插件 */ }
  }
}

export function apply(ctx: Context, config: Config = {} as Config) {
  // 连接配置优先级（与 README 一致）：GUI 卡片（settings.yaml 用户层）→ 环境变量 → 插件配置行。
  // settings 注册时 base 传空对象，使解析值只反映 GUI 用户层，环境变量与配置行在下方回退。
  let settingsSource: () => Config = () => ({} as Config)

  // 客户端复用：同一配置（baseUrl/apiToken/timeoutMs）复用同一 OutlineClient 实例，
  // 使其 60s 文档缓存跨工具调用生效（与 README 承诺一致）；配置变更后按 key 自动重建。
  let cachedClient: { key: string; client: OutlineClient } | null = null
  const makeClient = (): OutlineClient => {
    const s = settingsSource()
    const baseUrl = (s.baseUrl ?? '').trim()
      || (process.env.OUTLINE_BASE_URL ?? '').trim()
      || (config.baseUrl ?? '').trim()
    const apiToken = (s.apiToken ?? '').trim()
      || (process.env.OUTLINE_API_TOKEN ?? '').trim()
      || (config.apiToken ?? '').trim()
    if (!baseUrl || !apiToken) {
      throw new Error(
        'dsh-outline 未配置：需要 baseUrl 与 apiToken（可在 设置 → 插件 → 插件配置 填写，或环境变量 OUTLINE_BASE_URL / OUTLINE_API_TOKEN）。配置方法见插件 README。',
      )
    }
    const timeoutMs = config.timeoutMs ?? 15000
    const cacheTtlMs = config.cacheTtlMs ?? 60000
    const key = `${baseUrl}\u0000${apiToken}\u0000${timeoutMs}\u0000${cacheTtlMs}`
    if (cachedClient !== null && cachedClient.key === key) return cachedClient.client
    const client = new OutlineClient({ baseUrl, apiToken, timeoutMs, cacheTtlMs })
    cachedClient = { key, client }
    return client
  }

  // 可写目录白名单：settings 用户层 → 插件配置 → 默认空（只读模式）。
  const getWritablePaths = (): string => {
    const s = settingsSource()
    return (s.writablePaths ?? config.writablePaths ?? '').trim()
  }

  // 本地保存目录：settings 用户层 → 插件配置 → 默认 DSH_HOME/outline-auto-saves → 回退 HOME。
  const getLocalSaveDir = (): string => {
    const s = settingsSource()
    return resolveLocalSaveDir(s.localSaveDir ?? config.localSaveDir)
  }

  // settings 的 base 层 = 插件配置行 + 环境变量（env 优先于配置行）。
  // 这样用户层未覆盖时解析值仍含部署连接信息，客户端卡片据此显示“已配置”，
  // 且卡片字段能回显部署默认值（apiToken 由客户端掩码，不回显明文）。
  const settingsBase: Config = {
    ...config,
    ...(config.baseUrl === undefined || config.baseUrl === ''
      ? (process.env.OUTLINE_BASE_URL ? { baseUrl: process.env.OUTLINE_BASE_URL } : {})
      : {}),
    ...(config.apiToken === undefined || config.apiToken === ''
      ? (process.env.OUTLINE_API_TOKEN ? { apiToken: process.env.OUTLINE_API_TOKEN } : {})
      : {}),
  }
  try {
    ctx.inject(['settings'], (sctx) => {
      try {
        sctx.settings.installSection(ctx, SETTINGS_NS, Config, settingsBase, {
          setSource: (current) => {
            settingsSource = current
          },
          onChange: () => {},
        })
      } catch (err) {
        report(ctx, 'settings section unavailable; GUI card will not persist config', err)
      }
    })
  } catch (err) {
    report(ctx, 'settings injection unavailable; GUI card will not persist config', err)
  }

  // 同义词/别名表：settings 用户层 → 插件配置行 → 空（关闭回退）。
  const getSynonyms = (): Record<string, string[]> => {
    const s = settingsSource()
    return s.synonyms ?? config.synonyms ?? {}
  }

  // 兼容性加固：逐个工具独立注册并各自 try/catch。宿主升级若改动了工具注册
  // API 或某个工具的工厂签名，只降级该工具并打日志，其余工具照常可用，
  // 且绝不向外抛异常（apply 抛异常会让 DSH 拒绝启动整个插件树）。
  const tools = ctx.tools as { register?: (tool: never) => void } | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    report(ctx, 'tools.register API changed; Outline tools not registered')
    return
  }
  const toolFactories: Array<[string, () => unknown]> = [
    ['outline_search', () => outlineSearchTool(makeClient, config.searchLimit ?? 10, getLocalSaveDir, getSynonyms)],
    ['outline_context_search', () => outlineContextSearchTool(makeClient, config.searchLimit ?? 10)],
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
      const approval = ctx.get('approval')
      if (approval === undefined) return false
      const outcome = await approval.request({
        agent: exec.agent as never,
        toolName: 'outline_delete',
        callId: exec.callId as never,
        reason,
      })
      return outcome === 'allowed-once'
    })],
  ]
  for (const [label, factory] of toolFactories) {
    try {
      tools.register(factory() as never)
    } catch (err) {
      report(ctx, `tool "${label}" was not registered`, err)
    }
  }

  // 写工具审批闸：create/update/delete 需用户确认；目录白名单或权限不满足时直接拒绝（连审批都不弹）。
  // 兼容性加固：闸门自身任何异常都按 fail-closed 处理（一律拒绝写操作），
  // 绝不因宿主 API 变化而放行写入；读工具不受影响。
  if (typeof ctx.on !== 'function') {
    report(ctx, 'ctx.on unavailable; Outline write-approval gate not installed')
    return
  }
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec.name as string
      if (name !== 'outline_create' && name !== 'outline_update_document' && name !== 'outline_delete') {
        return next()
      }
      try {
        const args = (exec.arguments ?? {}) as Record<string, string | undefined>
        const client = makeClient()
        // ① 目录白名单校验（fail-closed；空白名单 = 只读模式，直接拒绝）
        let collections: OutlineCollection[] = []
        try {
          collections = await client.listCollections()
        } catch {
          // collections 为空 → resolveWriteGuard fails closed when it cannot verify the target
        }
        const pathGuard = await (async () => {
          try {
            if (name === 'outline_create') {
              const a = args as { collectionId?: string; parentDocumentId?: string }
              return await resolvePathGuard(
                client,
                { kind: 'create', collectionId: a.collectionId ?? '', parentDocumentId: a.parentDocumentId },
                parseWritablePaths(getWritablePaths()),
                collections,
              )
            }
            return await resolvePathGuard(client, { kind: 'doc', docId: args.id ?? '' }, parseWritablePaths(getWritablePaths()), collections)
          } catch {
            return '无法解析写入目标路径：目标集合或文档不可见。为避免误写，本次操作已拒绝。'
          }
        })()
        if (pathGuard !== null) return { kind: 'deny', reason: pathGuard }

        // ② 集合存在与 token 权限
        let collectionId: string | undefined
        try {
          collectionId = name === 'outline_create'
            ? (args as { collectionId?: string }).collectionId
            : (await client.getDocument(args.id ?? '')).collectionId
        } catch {
          // resolveWriteGuard deliberately denies an unverifiable target.
        }
        const guard = resolveWriteGuard(collections, collectionId ?? '')
        if (guard !== null) return { kind: 'deny', reason: guard }

        // ③ 审批
        if (name === 'outline_create') {
          const a = args as { collectionId?: string; title?: string; text?: string; parentDocumentId?: string }
          let collectionName: string | undefined
          let resolvedPath: string[] | undefined
          collectionName = collections.find((c) => c.id === a.collectionId)?.name
          if (a.parentDocumentId !== undefined && a.parentDocumentId !== '') {
            try {
              resolvedPath = await client.resolveDocumentPath(a.parentDocumentId)
            } catch {
              resolvedPath = undefined
            }
          }
          return { kind: 'ask', reason: buildCreateApprovalReason(a, collectionName, resolvedPath) }
        }

        // 参数校验前置：update 至少需要 title 或 text（在路径解析前拦截，避免无意义 API 调用）
        if (name === 'outline_update_document' && (args.title === undefined || args.title === '') && (args.text === undefined || args.text === '')) {
          return { kind: 'deny', reason: 'outline_update_document 至少需要 title 或 text 之一' }
        }

        let docPath: string[] | undefined
        try {
          docPath = await client.resolveDocumentPath(args.id ?? '')
        } catch {
          // 解析失败仍继续走 ask（reason 里看不到路径也至少让用户确认操作）
        }
        const where = docPath !== undefined && docPath.length > 0 ? `路径：${docPath.join(' / ')}` : `文档 id：${args.id ?? ''}`
        if (name === 'outline_update_document') {
          const changes = [args.title !== undefined ? '改标题' : '', args.text !== undefined ? '改正文' : ''].filter(Boolean).join(' + ')
          return { kind: 'ask', reason: `将更新 Outline 文档：\n${where}\n变更：${changes}` }
        }
        return { kind: 'ask', reason: `将删除 Outline 文档（第 1 次确认）：\n${where}` }
      } catch (err) {
        report(ctx, `write-approval gate failed for "${name}"; the write was denied`, err)
        return {
          kind: 'deny',
          reason: '写入审批闸内部错误，为安全起见本次写操作已拒绝。'
            + (err instanceof Error && err.message ? '（' + err.message + '）' : ''),
        }
      }
    })
  } catch (err) {
    report(ctx, 'ctx.on("tools/pre-execute") failed; write-approval gate not installed', err)
  }
}
