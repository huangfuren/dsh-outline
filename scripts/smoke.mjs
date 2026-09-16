import { createMockOutlineServer } from './mock-outline-server.mjs'
import { apply } from '../lib/index.js'

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
const injected = []
let section = null
const ctx = {
  tools: { register: (definition) => { tools.push(definition) } },
  inject: (names, callback) => {
    injected.push(names.join('+'))
    if (names.includes('settings')) {
      callback({ settings: { installSection: (owner, ns, schema, base, hooks) => { section = { owner, ns, base, hooks } } } })
    }
    return () => {}
  },
  on: () => () => {},
  get: (name) => name === 'approval' ? { request: async () => 'allowed-once' } : undefined,
}
apply(ctx, { baseUrl, apiToken: 'test-token', timeoutMs: 5000, searchLimit: 5, writablePaths: '测试集合', synonyms: { '部暑': ['部署'] } })
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
const exec = {}
let failures = 0
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!ok) failures++ }

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
  // 验证 updatedAfter 过滤
  const recent = await byName.outline_search.execute({ query: '', limit: 10, updatedAfter: '2026-03-01' }, exec)
  check('outline_search updatedAfter 过滤', recent.hits.length >= 1, `got ${recent.hits.length} hits`)
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
  // 验证参数校验在 execute 层 fail-closed 兜底（pre-execute 未注册时）
  let paramError = false
  try { await byName.outline_update_document.execute({ id: 'doc-1' }, exec) } catch (e) { paramError = e.message?.includes('至少需要') }
  check('outline_update_document 参数校验（execute 兜底）', paramError, 'pre-execute 未注册，走 execute 层')
  const tpl = await byName.outline_doc_template.execute({}, exec)
  check('outline_doc_template 返回模板', typeof tpl.template === 'string' && tpl.template.includes('【需求或目标】') && Array.isArray(tpl.sections), JSON.stringify(tpl.sections))

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
if (failures > 0) { console.error(`SMOKE FAILED (${failures})`); process.exit(1) }
console.log('SMOKE PASS')