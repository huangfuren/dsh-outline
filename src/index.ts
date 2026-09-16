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
  buildCreateApprovalReason, resolveWriteGuard,
  parseWritablePaths, resolvePathGuard, resolveLocalSaveDir,
} from './tools.js'
import type { OutlineCollection } from './client.js'

export const name = 'dsh-outline-auto'
export const inject = ['tools']

/** GUI 设置命名空间（设置 → 插件 → 插件配置 的卡片读写它，持久化在 settings.yaml）。 */
const SETTINGS_NS = 'outline-auto'

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
        'dsh-outline-auto 未配置：需要 baseUrl 与 apiToken（可在 设置 → 插件 → 插件配置 填写，或环境变量 OUTLINE_BASE_URL / OUTLINE_API_TOKEN）。配置方法见插件 README。',
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
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NS, Config, settingsBase, {
      setSource: (current) => {
        settingsSource = current
      },
      onChange: () => {},
    })
  })

  // 同义词/别名表：settings 用户层 → 插件配置行 → 空（关闭回退）。
  const getSynonyms = (): Record<string, string[]> => {
    const s = settingsSource()
    return s.synonyms ?? config.synonyms ?? {}
  }

  ctx.tools.register(outlineSearchTool(makeClient, config.searchLimit ?? 10, getLocalSaveDir, getSynonyms))
  ctx.tools.register(outlineGetDocumentTool(makeClient, getLocalSaveDir))
  ctx.tools.register(outlineCountTool(makeClient))
  ctx.tools.register(outlineListCollectionsTool(makeClient))
  ctx.tools.register(outlineListUsersTool(makeClient))
  ctx.tools.register(outlineResolvePathTool(makeClient))
  ctx.tools.register(outlineListChildrenTool(makeClient))
  ctx.tools.register(outlineDocTemplateTool())
  ctx.tools.register(outlineSaveLocalTool(getLocalSaveDir, makeClient))
  ctx.tools.register(outlineCreateTool(makeClient, getWritablePaths))
  ctx.tools.register(outlineUpdateDocumentTool(makeClient, getWritablePaths))
  ctx.tools.register(outlineDeleteTool(makeClient, getWritablePaths, async (reason, exec) => {
    const approval = ctx.get('approval')
    if (approval === undefined) return false
    const outcome = await approval.request({
      agent: exec.agent as never,
      toolName: 'outline_delete',
      callId: exec.callId as never,
      reason,
    })
    return outcome === 'allowed-once'
  }))

  // 写工具审批闸：create/update/delete 需用户确认；目录白名单或权限不满足时直接拒绝（连审批都不弹）。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const name = exec.name
    const args = (exec.arguments ?? {}) as Record<string, string | undefined>

    if (name !== 'outline_create' && name !== 'outline_update_document' && name !== 'outline_delete') {
      return next()
    }

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
  })
}
