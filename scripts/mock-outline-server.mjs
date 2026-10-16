import http from 'node:http'

const DOCS = [
  { id: 'doc-1', title: '部署规范', url: '/doc/deploy', collectionId: 'col-1', authorId: 'user-1', updatedAt: '2026-01-01T00:00:00Z', text: '# 部署规范\n\n## 环境\n\n- 生产：prod.example.com\n\n## 步骤\n\n1. 构建\n2. 推送镜像\n3. 发布' },
  { id: 'doc-2', title: '代码评审规范', url: '/doc/review', collectionId: 'col-1', authorId: 'user-2', updatedAt: '2026-02-01T00:00:00Z', text: '# 代码评审规范\n\n评审人需在 24 小时内完成评审。' },
  { id: 'doc-3', title: '新员工入职指南', url: '/doc/onboarding', collectionId: 'col-2', authorId: 'user-1', updatedAt: '2026-03-01T00:00:00Z', text: '# 新员工入职指南\n\n欢迎加入！' },
]

export function createMockOutlineServer() {
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
      if (req.url === '/api/documents.search') {
        const query = String(parsed.query ?? '').toLowerCase()
        const limit = Number(parsed.limit ?? 10)
        const offset = Number(parsed.offset ?? 0) || 0
        const collectionId = String(parsed.collectionId ?? '').trim()
        const userId = String(parsed.userId ?? '').trim()
        const updatedAfter = String(parsed.updatedAfter ?? '').trim()
        let matches = DOCS.filter((doc) => doc.title.toLowerCase().includes(query) || doc.text.toLowerCase().includes(query))
        if (collectionId !== '') matches = matches.filter((doc) => doc.collectionId === collectionId)
        if (userId !== '') matches = matches.filter((doc) => doc.authorId === userId)
        if (updatedAfter !== '') {
          const after = new Date(updatedAfter).getTime()
          if (!Number.isNaN(after)) matches = matches.filter((doc) => new Date(doc.updatedAt).getTime() >= after)
        }
        const hits = matches.slice(offset, offset + limit)
          .map((doc) => ({ context: doc.text.slice(0, 40), document: { id: doc.id, title: doc.title, url: doc.url, collectionId: doc.collectionId, updatedAt: doc.updatedAt, user: { id: doc.authorId } } }))
        send(200, { data: hits, pagination: { total: matches.length } })
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
        send(200, {
          data: DOCS.slice(0, limit).map((d) => ({ id: d.id, title: d.title, url: d.url, collectionId: d.collectionId, updatedAt: d.updatedAt })),
          pagination: { total: DOCS.length },
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
        // append: true 走 Outline 原生追加语义（不覆盖原文）—— 用于验证长文改动路径
        if (parsed.text !== undefined) doc.text = parsed.append === true ? doc.text + parsed.text : parsed.text
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