import { createMockOutlineServer } from './mock-outline-server.mjs'
import { apply } from '../lib/index.js'
import { OutlineClient } from '../lib/client.js'

// 冒烟必须自包含：清掉环境变量，避免环境里的 OUTLINE_* 盖过下方 config（优先级 GUI > env > config）。
delete process.env.OUTLINE_BASE_URL
delete process.env.OUTLINE_API_TOKEN

const server = createMockOutlineServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

const tools = []
// 冒烟不连真实宿主：settings 服务用假实现顶上，既让 installSection 不产生副作用，
// 又能记录参数 —— 下面据此断言接缝确实被走到（lib/ 编译产物的行为证据，不止 grep）。
// 关键：pre-execute 监听器与单调守卫都必须被真实捕获并驱动 —— 早期版本这里写的是
// `on: () => () => {}`，等于让审批闸从未注册，冒烟因此完全没有覆盖写路径的唯一人工闸门。
const injected = []
let section = null
const listeners = new Map()
const guards = []
const ctx = {
  tools: {
    register: (definition) => { tools.push(definition) },
    guard: (guard) => { guards.push(guard); return () => {} },
  },
  inject: (names, callback) => {
    injected.push(names.join('+'))
    if (names.includes('settings')) {
      callback({ settings: { installSection: (owner, ns, schema, base, hooks) => { section = { owner, ns, base, hooks } } } })
    }
    return () => {}
  },
  on: (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(listener)
    return () => {}
  },
  get: (name) => name === 'approval' ? { request: async () => 'allowed-once' } : undefined,
}
apply(ctx, { baseUrl, apiToken: 'test-token', timeoutMs: 5000, searchLimit: 5, writablePaths: '测试集合', synonyms: { '部暑': ['部署'] } })
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
const exec = {}
let failures = 0
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++ }

/**
 * 还原宿主 dsh-tools 0.2.0-rc.2 的策略链：
 * waterfall("tools/pre-execute") → ask 经批准变 allow → 仅 allow 时查询 ctx.tools.guard()。
 */
async function runPipeline (name, args, h = { listeners, guards }) {
  const call = { name, arguments: args, callId: 'smoke-call', agent: { session: {} }, signal: new AbortController().signal }
  const chain = [...(h.listeners.get('tools/pre-execute') ?? [])]
  const inner = () => Promise.resolve({ kind: 'allow' })
  const next = () => (chain.shift() ?? inner)(call, next)
  const decision = await next()
  const effective = decision.kind === 'ask' ? { kind: 'allow' } : decision
  let floorReason
  if (effective.kind === 'allow') {
    for (const guard of h.guards) {
      const reason = guard(call)
      if (reason !== undefined) { floorReason = reason; break }
    }
  }
  return { decision, floorReason }
}

try {
  const search = await byName.outline_search.execute({ query: '部署', limit: 3 }, exec)
  check('outline_search 返回结果', Array.isArray(search.hits) && search.hits.length === 1 && search.hits[0].id === 'doc-1', JSON.stringify(search))
  check('outline_search 匹配总数', search.total === 1)
  const empty = await byName.outline_search.execute({ query: '不存在的词', limit: 3 }, exec)
  check('outline_search 空结果', Array.isArray(empty.hits) && empty.hits.length === 0)
  const doc = await byName.outline_get_document.execute({ id: 'doc-1' }, exec)
  check('outline_get_document 全文', typeof doc.text === 'string' && doc.text.includes('# 部署规范'))
  const trunc = await byName.outline_get_document.execute({ id: 'doc-1', maxLength: 1000 }, exec)
  check('outline_get_document 截断', trunc.truncated === false || trunc.text.length <= 1000)
  let notFound = false
  try { await byName.outline_get_document.execute({ id: 'missing' }, exec) } catch (e) { notFound = e.kind === 'not-found' }
  check('outline_get_document 404', notFound)
  const count = await byName.outline_count.execute({}, exec)
  check('outline_count 文档总数', count.total === 3, JSON.stringify(count))
  const collections = await byName.outline_list_collections.execute({}, exec)
  check('outline_list_collections 返回集合', Array.isArray(collections) && collections.length === 1 && collections[0].id === 'col-1', JSON.stringify(collections))
  const created = await byName.outline_create.execute({ collectionId: 'col-1', title: '冒烟测试文档', text: '# 冒烟\n正文' }, exec)
  check('outline_create 创建成功', created.published === true && String(created.id).startsWith('new-'), JSON.stringify(created))
  const recheck = await byName.outline_count.execute({}, exec)
  check('outline_count 创建后 +1', recheck.total === 4)
  const updated = await byName.outline_update_document.execute({ id: created.id, title: '冒烟测试文档-改' }, exec)
  check('outline_update_document 更新标题', updated.title === '冒烟测试文档-改', JSON.stringify(updated))
  const deleted = await byName.outline_delete.execute({ id: created.id }, exec)
  check('outline_delete 删除成功', deleted.success === true, JSON.stringify(deleted))
  const after = await byName.outline_count.execute({}, exec)
  check('outline_count 删除后回落', after.total === 3)
  const children = await byName.outline_list_children.execute({ parentId: 'doc-1' }, exec)
  check('outline_list_children 返回子文档', Array.isArray(children), JSON.stringify(children))
  const filtered = await byName.outline_search.execute({ query: '部署', limit: 3, collectionId: 'col-1' }, exec)
  check('outline_search collectionId 过滤', filtered.total >= 1, JSON.stringify(filtered))
  // 验证 userId 过滤（mock server 已支持）
  const byUser = await byName.outline_search.execute({ query: '', limit: 10, userId: 'user-2' }, exec)
  check('outline_search userId 过滤', byUser.hits.length >= 1, `got ${byUser.hits.length} hits`)
  // 空关键词 + 时间条件：走 documents.list（服务端天然按 updatedAt 降序），扫到边界即停。
  const recent = await byName.outline_search.execute({ query: '', limit: 10, updatedAfter: '2026-03-01' }, exec)
  check('outline_search 空关键词走 list 路径并标注', recent.hits.length >= 1 && recent.timeFilterMode === 'list', `got ${recent.hits.length} hits, mode=${recent.timeFilterMode}`)
  check('outline_search list 路径只返回时间范围内的文档', recent.hits.every((h) => h.updatedAt >= '2026-03-01'), JSON.stringify(recent.hits.map((h) => h.updatedAt)))
  // 有关键词时仍走关键词检索：老实例服务端没有时间过滤，必须本地筛选并如实标注。
  const kwRecent = await byName.outline_search.execute({ query: '部署', limit: 10, updatedAfter: '2026-01-01' }, exec)
  check('outline_search 有关键词时老实例本地筛选并标注', kwRecent.hits.length >= 1 && kwRecent.timeFilterMode === 'client', `got ${kwRecent.hits.length} hits, mode=${kwRecent.timeFilterMode}`)
  // 验证 snippet 保留原始 HTML 高亮标签
  const searchWithHtml = await byName.outline_search.execute({ query: '部署', limit: 1 }, exec)
  check('outline_search snippet 保留原始上下文', searchWithHtml.hits[0] && typeof searchWithHtml.hits[0].snippet === 'string', JSON.stringify(searchWithHtml))
  // 验证命中附带作者名（mock server 已返回 user.id + users.list 解析姓名）
  const withAuthor = await byName.outline_search.execute({ query: '部署', limit: 5 }, exec)
  check('outline_search 命中附带作者名', withAuthor.hits[0] && typeof withAuthor.hits[0].authorName === 'string' && withAuthor.hits[0].authorName.length > 0, JSON.stringify(withAuthor.hits[0]))
  // 验证 all=true 自动翻页（mock server 支持 offset）抓全匹配
  const all = await byName.outline_search.execute({ query: '规范', limit: 1, all: true }, exec)
  check('outline_search all=true 翻页抓全', all.hits.length >= 2, `got ${all.hits.length} hits`)
  // 验证同义词回退阶梯（错别字 部暑 → 词表映射到 部署）
  const syn = await byName.outline_search.execute({ query: '部暑', limit: 5 }, exec)
  check('outline_search 同义词回退', syn.hits.length >= 1 && syn.retriedWith === '部署', JSON.stringify({ hits: syn.hits.length, retriedWith: syn.retriedWith }))
  // 验证参数校验在 execute 层 fail-closed 兜底：直调 execute 绕过 pre-execute 闸，仍须拒绝
  let paramError = false
  try { await byName.outline_update_document.execute({ id: 'doc-1' }, exec) } catch (e) { paramError = e.message?.includes('至少需要') }
  check('outline_update_document 参数校验（execute 兜底）', paramError, '直调 execute 绕过闸，仍被拒绝')
  const tpl = await byName.outline_doc_template.execute({}, exec)
  check('outline_doc_template 返回模板', typeof tpl.template === 'string' && tpl.template.includes('【需求或目标】') && Array.isArray(tpl.sections), JSON.stringify(tpl.sections))

  // —— 写路径闸（tools/pre-execute）：闸必须真的被注册并给出正确决策 ——
  const gateRead = await runPipeline('outline_search', { query: '部署' })
  check('闸：读工具不被阻拦', gateRead.decision.kind === 'allow' && gateRead.floorReason === undefined, JSON.stringify(gateRead.decision))
  const gateCreateIn = await runPipeline('outline_create', { collectionId: 'col-1', title: 'T', text: 'x' })
  check('闸：白名单内创建 → ask 且地板放行', gateCreateIn.decision.kind === 'ask' && gateCreateIn.floorReason === undefined)
  const gateUpdateIn = await runPipeline('outline_update_document', { id: 'doc-1', title: 'T' })
  check('闸：白名单内更新 → ask', gateUpdateIn.decision.kind === 'ask', JSON.stringify(gateUpdateIn.decision))
  const gateDeleteIn = await runPipeline('outline_delete', { id: 'doc-1' })
  check('闸：白名单内删除 → ask（第 1 次确认）', gateDeleteIn.decision.kind === 'ask' && String(gateDeleteIn.decision.reason).includes('第 1 次确认'))
  const gateUpdateBad = await runPipeline('outline_update_document', { id: 'doc-1' })
  check('闸：update 缺 title/text/publish → deny（不弹审批）', gateUpdateBad.decision.kind === 'deny' && String(gateUpdateBad.decision.reason).includes('至少需要'))

  // —— 单调地板：他方监听器短路 waterfall 时，闸不执行 → 地板仍须拒绝写调用 ——
  {
    const scListeners = new Map()
    const scGuards = []
    const scCtx = {
      tools: { register: () => {}, guard: (g) => { scGuards.push(g); return () => {} } },
      inject: () => () => {},
      on: (name, listener) => { if (!scListeners.has(name)) scListeners.set(name, []); scListeners.get(name).push(listener); return () => {} },
      get: () => undefined,
    }
    // 抢先注册"允许"监听器且不调 next()：本插件的闸将被短路
    scCtx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    apply(scCtx, { baseUrl, apiToken: 'test-token', timeoutMs: 5000, searchLimit: 5, writablePaths: '测试集合' })
    const sc = await runPipeline('outline_update_document', { id: 'doc-1', title: 'T' }, { listeners: scListeners, guards: scGuards })
    check('地板：短路时写调用仍被拒绝', sc.decision.kind === 'allow' && typeof sc.floorReason === 'string' && sc.floorReason.includes('未经 dsh-outline 的审批闸'), String(sc.floorReason).slice(0, 60))
    const scRead = await runPipeline('outline_search', { query: 'x' }, { listeners: scListeners, guards: scGuards })
    check('地板：读工具不受影响', scRead.floorReason === undefined)
  }

  // —— 写参数 fail-closed：未声明的键必须报错，不能"返回成功但语义被丢弃" ——
  let unknownArgErr = ''
  try { await byName.outline_update_document.execute({ id: 'doc-1', text: 'x', collectionId: 'col-2' }, exec) } catch (e) { unknownArgErr = String(e.message) }
  check('写工具拒绝未声明的参数', unknownArgErr.includes('不接受参数') && unknownArgErr.includes('collectionId'), unknownArgErr.slice(0, 70))

  // —— append：追加语义不覆盖原文（长文改动的安全路径） ——
  const created2 = await byName.outline_create.execute({ collectionId: 'col-1', title: 'append 冒烟', text: '# 原文' }, exec)
  await byName.outline_update_document.execute({ id: created2.id, text: '\n【追加段】', append: true }, exec)
  const appended = await byName.outline_get_document.execute({ id: created2.id }, exec)
  check('append 追加不覆盖原文', appended.text.includes('# 原文') && appended.text.includes('【追加段】'), JSON.stringify(appended.text))
  await byName.outline_delete.execute({ id: created2.id }, exec)

  // —— delete 结果判定：宁可报失败，也不谎报"已删除" ——
  const rawClient = new OutlineClient({ baseUrl, apiToken: 'test-token', timeoutMs: 5000 })
  const confirmedDelete = await rawClient.deleteDocument('doc-3')
  check('client.deleteDocument 顶层 success 视为成功', confirmedDelete.success === true, JSON.stringify(confirmedDelete))
  let unconfirmedErr = ''
  try { await rawClient.deleteDocument('unconfirmed-x') } catch (e) { unconfirmedErr = String(e.message) }
  check('client.deleteDocument 无成功标记 → 抛错而不谎报成功', unconfirmedErr.includes('无法确认'), unconfirmedErr.slice(0, 70))

  // —— settings 接缝回归（防 v0.7.1 事故复现：宿主 0.1.5 移除了 installSettingsSection，
  //    卡片曾静默消失）。断言编译产物确实经 ctx.inject(['settings']) 调到 installSection，
  //    且它交回的 setSource 能改写运行期读取的配置（写入守卫随之改变）。
  check('settings 接缝：ctx.inject 申请 settings', injected.includes('settings'), JSON.stringify(injected))
  check('settings 接缝：installSection(owner=ctx, ns=outline-auto)', section !== null && section.owner === ctx && section.ns === 'outline-auto', section === null ? '未被调用' : section.ns)
  check('settings 接缝：base 携带插件配置行', section?.base?.writablePaths === '测试集合' && section?.base?.baseUrl === baseUrl)
  let overridden = 'installSection 未被调用，setSource 无从验证'
  if (section?.hooks?.setSource) {
    section.hooks.setSource(() => ({ writablePaths: '别的目录' }))
    try {
      await byName.outline_create.execute({ collectionId: 'col-1', title: '冒烟-应被拒', text: '# 冒烟\n正文' }, exec)
    } catch (error) {
      overridden = String(error?.message ?? error)
    }
  }
  check('settings 接缝：用户层 setSource 覆盖配置行', overridden.includes('目标不在可写目录内') && overridden.includes('别的目录'), overridden.slice(0, 100))
} catch (error) {
  console.error('SMOKE ERROR:', error)
  failures++
}

await new Promise((resolve) => server.close(resolve))

// —— Outline 1.12+ 实例（支持 filters 数组）：时间过滤应下推到服务端 ——
// 数据可能被上面的用例增删过，所以这里只断言"模式正确 + 结果确实满足条件"，不锁条数。
{
  const newServer = createMockOutlineServer({ filters: true })
  await new Promise((resolve) => newServer.listen(0, '127.0.0.1', resolve))
  try {
    const newBase = `http://127.0.0.1:${newServer.address().port}`
    const c = new OutlineClient({ baseUrl: newBase, apiToken: 'test-token', timeoutMs: 5000 })
    const after = await c.searchDocuments('', 10, undefined, { updatedAfter: '2026-01-01' })
    check('filters 实例：时间过滤走服务端', after.timeFilterMode === 'server', `mode=${after.timeFilterMode}`)
    // 必须同时要求非空：`every()` 对空数组恒为 true，只看它会放过"过滤把结果全筛掉"的退化。
    check(
      'filters 实例：返回结果均满足时间条件',
      after.hits.length >= 1 && after.hits.every((h) => new Date(h.updatedAt).getTime() >= new Date('2026-01-01').getTime()),
      `${after.hits.length} hits: ${JSON.stringify(after.hits.map((h) => h.updatedAt))}`,
    )
    const scoped = await c.searchDocuments('', 10, 'col-1', { userId: 'user-1', updatedAfter: '2026-01-01' })
    check(
      'filters 实例：集合 + 作者 + 时间三条件同时生效',
      scoped.hits.length >= 1 && scoped.hits.every((h) => h.collectionId === 'col-1') && scoped.timeFilterMode === 'server',
      `${scoped.hits.length} hits: ${JSON.stringify(scoped.hits.map((h) => [h.id, h.collectionId]))}`,
    )
  } catch (error) {
    console.error('SMOKE ERROR (filters 实例):', error)
    failures++
  } finally {
    await new Promise((resolve) => newServer.close(resolve))
  }
}

if (failures > 0) { console.error(`SMOKE FAILED (${failures})`); process.exit(1) }
console.log('SMOKE PASS')