import http from 'node:http'

const DOCS = [
  { id: 'doc-1', title: '部署规范', url: '/doc/deploy', collectionId: 'col-1', authorId: 'user-1', updatedAt: '2026-01-01T00:00:00Z', text: '# 部署规范\n\n## 环境\n\n- 生产：prod.example.com\n\n## 步骤\n\n1. 构建\n2. 推送镜像\n3. 发布' },
  { id: 'doc-2', title: '代码评审规范', url: '/doc/review', collectionId: 'col-1', authorId: 'user-2', updatedAt: '2026-02-01T00:00:00Z', text: '# 代码评审规范\n\n评审人需在 24 小时内完成评审。' },
  { id: 'doc-3', title: '新员工入职指南', url: '/doc/onboarding', collectionId: 'col-2', authorId: 'user-1', updatedAt: '2026-03-01T00:00:00Z', text: '# 新员工入职指南\n\n欢迎加入！' },
]

/**
 * 过滤器条件求值（模拟 Outline 1.12+ 的 filters 数组）。
 * 只实现插件实际用到的字段与算子：collectionId / userId 的 eq、updatedAt 的 gte。
 */
function matchesCondition(doc, condition) {
  const { field, operator, value } = condition
  const compare = (left, right) => {
    if (operator === 'eq') return left === right
    if (operator === 'gte') return left >= right
    if (operator === 'gt') return left > right
    if (operator === 'lte') return left <= right
    if (operator === 'lt') return left < right
    return false
  }
  if (field === 'collectionId') return compare(doc.collectionId, value)
  if (field === 'userId') return compare(doc.authorId, value)
  if (field === 'updatedAt') {
    const left = new Date(doc.updatedAt).getTime()
    const raw = String(value)
    // ISO 8601 duration（-P1D/-P1W/-P1M/-P1Y）表示相对当前时间的窗口，其余按绝对日期解析
    const rel = raw.match(/^-P(\d+)([DWMY])$/)
    if (rel) {
      const n = Number(rel[1])
      const unit = { D: 86400000, W: 7 * 86400000, M: 30 * 86400000, Y: 365 * 86400000 }[rel[2]]
      return compare(left, Date.now() - n * unit)
    }
    const right = new Date(raw).getTime()
    return Number.isFinite(right) ? compare(left, right) : false
  }
  return false
}

/** 旧参数与新 filters 互斥（Outline 1.12+ 的 refine：同时出现直接 400）。 */
const LEGACY_FILTER_KEYS = ['collectionId', 'userId', 'documentId', 'dateFilter', 'statusFilter', 'parentDocumentId']

/**
 * @param {{ filters?: boolean }} options
 *   `filters: false`（默认）模拟 Outline ≤ 1.11：未知的 `filters` 被静默丢弃，只认旧参数；
 *   `filters: true` 模拟 Outline 1.12+：支持 filters 数组，且与旧参数互斥。
 */
export function createMockOutlineServer({ filters: supportsFilters = false } = {}) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end('{"error":"method not allowed"}'); return }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (token === 'invalid') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"authentication_required"}'); return }
      let parsed = {}
      try { parsed = JSON.parse(body || '{}') } catch { /* ignore */ }
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
      const hasFilters = supportsFilters && Array.isArray(parsed.filters)
      // 新版：filters 与旧参数同时出现 → 400（与真实 refine 一致）
      if (hasFilters) {
        const conflict = LEGACY_FILTER_KEYS.find((k) => parsed[k] !== undefined && parsed[k] !== null && parsed[k] !== '')
        if (conflict !== undefined) {
          send(400, { ok: false, error: 'Invalid input', message: `filters cannot be combined with deprecated parameters ${conflict}` })
          return
        }
      }
      /** 按实例能力套用过滤：新版走 filters，老版走旧参数（忽略 filters）。 */
      const applyFilters = (docs) => {
        if (hasFilters) return docs.filter((doc) => parsed.filters.every((c) => matchesCondition(doc, c)))
        let out = docs
        const collectionId = String(parsed.collectionId ?? '').trim()
        const userId = String(parsed.userId ?? '').trim()
        if (collectionId !== '') out = out.filter((doc) => doc.collectionId === collectionId)
        if (userId !== '') out = out.filter((doc) => doc.authorId === userId)
        return out
      }
      if (req.url === '/api/documents.search') {
        const query = String(parsed.query ?? '').toLowerCase()
        const limit = Number(parsed.limit ?? 10)
        const offset = Number(parsed.offset ?? 0) || 0
        // 注意：服务端从不存在 updatedAfter 参数（任何版本都没有），这里刻意不实现它 ——
        // 早期 mock 自己实现了该过滤，导致"服务端不生效"的缺陷在冒烟里显示为通过。
        const matched = applyFilters(DOCS.filter((doc) => doc.title.toLowerCase().includes(query) || doc.text.toLowerCase().includes(query)))
        const hits = matched.slice(offset, offset + limit)
          .map((doc) => ({ context: doc.text.slice(0, 40), document: { id: doc.id, title: doc.title, url: doc.url, collectionId: doc.collectionId, updatedAt: doc.updatedAt, user: { id: doc.authorId } } }))
        send(200, { data: hits, pagination: { total: matched.length } })
        return
      }
      if (req.url === '/api/documents.info') {
        const doc = DOCS.find((d) => d.id === parsed.id)
        if (!doc) { send(404, { ok: false, error: 'not_found' }); return }
        send(200, { data: { id: doc.id, title: doc.title, url: doc.url, text: doc.text, updatedAt: doc.updatedAt, collectionId: doc.collectionId, parentDocumentId: doc.parentDocumentId } })
        return
      }
      if (req.url === '/api/documents.list') {
        const limit = Number(parsed.limit ?? 10)
        const matched = applyFilters(DOCS)
        send(200, {
          data: matched.slice(0, limit).map((d) => ({ id: d.id, title: d.title, url: d.url, collectionId: d.collectionId, updatedAt: d.updatedAt })),
          pagination: { total: matched.length },
        })
        return
      }
      if (req.url.startsWith('/api/users.list')) {
        send(200, {
          data: [
            { id: 'user-1', name: '张三', email: 'zhangsan@example.com' },
            { id: 'user-2', name: '李四' },
          ],
          pagination: { total: 2 },
        })
        return
      }
      if (req.url.startsWith('/api/collections.list')) {
        send(200, {
          data: [
            { id: 'col-1', name: '测试集合', permission: 'read_write', documentCount: DOCS.length },
          ],
          pagination: { total: 1 },
        })
        return
      }
      if (req.url === '/api/documents.create') {
        const { collectionId, title, text, publish } = parsed
        if (!collectionId || !title || !text) { send(400, { ok: false, error: 'validation_error', message: 'title/collectionId/text required' }); return }
        const doc = { id: 'new-' + DOCS.length, title, url: '/doc/new', collectionId, parentDocumentId: parsed.parentDocumentId, updatedAt: '2026-08-25T00:00:00Z', text }
        DOCS.push(doc)
        send(200, { data: { id: doc.id, title: doc.title, url: doc.url, published: publish !== false } })
        return
      }
      if (req.url === '/api/documents.update') {
        const doc = DOCS.find((d) => d.id === parsed.id)
        if (!doc) { send(404, { ok: false, error: 'not_found' }); return }
        if (parsed.title !== undefined) doc.title = parsed.title
        // 追加语义：v1.9+ 认 editMode，更早只认 append（真实服务端会把 append 转换后删除）。
        // 两个都认，才能验证插件"双发"确实在两种版本下都不会退化成整篇覆盖。
        const appending = parsed.editMode === 'append' || parsed.append === true
        if (parsed.text !== undefined) doc.text = appending ? doc.text + parsed.text : parsed.text
        send(200, {
          data: {
            id: doc.id, title: doc.title, url: doc.url,
            published: parsed.publish !== undefined ? parsed.publish : true,
          },
        })
        return
      }
      if (req.url === '/api/documents.delete') {
        // id 含 unconfirmed → 模拟"200 但无成功标记"的畸形响应，用于验证插件不会谎报已删除
        if (String(parsed.id).includes('unconfirmed')) { send(200, { data: {} }); return }
        const idx = DOCS.findIndex((d) => d.id === parsed.id)
        if (idx === -1) { send(404, { ok: false, error: 'not_found' }); return }
        DOCS.splice(idx, 1)
        // 与真实实例一致：成功标记在**顶层**（{success:true, ok:true}），不在 data 内层
        send(200, { success: true, ok: true, data: { id: parsed.id } })
        return
      }
      send(404, { ok: false, error: 'not_found' })
    })
  })
}