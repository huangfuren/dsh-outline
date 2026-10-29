import { describe, it, expect } from 'vitest'
import { OutlineClient, mapWithConcurrency } from '../src/client.js'
import { OutlineApiError } from '../src/errors.js'

type StubResponse = { status: number; body: unknown; headers?: Record<string, string> }

function stubFetch(handler: (url: string, init: RequestInit) => Promise<StubResponse>): typeof fetch {
  return (async (url: any, init: any) => {
    const r = await handler(String(url), init as RequestInit)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(r.body),
    } as unknown as Response
  }) as typeof fetch
}

const SEARCH_BODY = {
  data: [
    {
      context: '部署规范相关片段',
      document: { id: 'doc-1', title: '部署规范', url: '/doc/deploy', collectionId: 'col-1', updatedAt: '2026-01-01T00:00:00Z' },
    },
  ],
  pagination: {},
}

const INFO_BODY = {
  data: { id: 'doc-1', title: '部署规范', url: '/doc/deploy', text: '# 部署\n\n步骤…', updatedAt: '2026-01-01T00:00:00Z' },
}

describe('OutlineClient', () => {
  it('searchDocuments 解析 data[].document 并保留 context 片段', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com/',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        expect(url).toBe('https://outline.example.com/api/documents.search')
        expect(init.method).toBe('POST')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
        expect(JSON.parse(String(init.body))).toEqual({ query: '部署', limit: 5 })
        return { status: 200, body: SEARCH_BODY }
      }),
    })
    const { total, hits } = await client.searchDocuments('部署', 5)
    expect(hits).toHaveLength(1)
    expect(total).toBe(1) // pagination 缺省时回退为命中数
    expect(hits[0]).toMatchObject({ id: 'doc-1', title: '部署规范', snippet: '部署规范相关片段' })
  })

  it('searchDocuments 空结果返回空 hits，total 为 0', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: { data: [] } })),
    })
    expect(await client.searchDocuments('xyz', 10)).toEqual({ total: 0, hits: [] })
  })

  it('searchDocuments 从 pagination.total 返回关键词匹配总数', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({
        status: 200,
        body: { ...SEARCH_BODY, pagination: { total: 20399 } },
      })),
    })
    const { total, hits } = await client.searchDocuments('部署', 5)
    expect(total).toBe(20399)
    expect(hits).toHaveLength(1)
  })

  it('countDocuments 返回 documents.list 的文档总数', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        expect(url).toBe('https://outline.example.com/api/documents.list')
        expect(JSON.parse(String(init.body))).toEqual({ limit: 1 })
        return { status: 200, body: { data: [{ id: 'd' }], pagination: { total: 20399 } } }
      }),
    })
    expect(await client.countDocuments()).toBe(20399)
  })

  it('相对文档 url 被解析为可点击的绝对地址', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com/',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: SEARCH_BODY })),
    })
    const { hits } = await client.searchDocuments('部署', 5)
    const [hit] = hits
    expect(hit.url).toBe('https://outline.example.com/doc/deploy')

    const infoClient = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: INFO_BODY })),
    })
    const doc = await infoClient.getDocument('doc-1')
    expect(doc.url).toBe('https://outline.example.com/doc/deploy')
  })

  it('已是绝对地址的 url 保持不变', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({
        status: 200,
        body: {
          data: [
            {
              context: '',
              document: { id: 'doc-1', title: 'T', url: 'https://outline.other.com/doc/x', collectionId: 'c', updatedAt: '2026-01-01T00:00:00Z' },
            },
          ],
        },
      })),
    })
    const { hits } = await client.searchDocuments('部署', 5)
    const [hit] = hits
    expect(hit.url).toBe('https://outline.other.com/doc/x')
  })

  it('snippet 保留原始上下文（HTML 高亮标签不被剥离，聊天层负责渲染）', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({
        status: 200,
        body: {
          data: [
            {
              context: 'TDD的本质：<b>测试</b>不是&nbsp;验证代码，而是设计代码',
              document: { id: 'doc-1', title: '<b>部署</b>规范', url: '/doc/deploy', collectionId: 'c', updatedAt: '2026-01-01T00:00:00Z' },
            },
          ],
        },
      })),
    })
    const { hits } = await client.searchDocuments('部署', 5)
    const [hit] = hits
    // snippet 保留原始 HTML（<b> 高亮、&nbsp; 实体），聊天渲染层负责转义
    expect(hit.snippet).toBe('TDD的本质：<b>测试</b>不是&nbsp;验证代码，而是设计代码')
    // 标题仍做 stripHtml（标题是纯文本字段，不含高亮语义）
    expect(hit.title).toBe('部署规范')
  })

  it('getDocument 对同一文档走短期缓存，不重复请求', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => {
        calls += 1
        return { status: 200, body: INFO_BODY }
      }),
    })
    const first = await client.getDocument('doc-1')
    const second = await client.getDocument('doc-1')
    expect(first.title).toBe('部署规范')
    expect(second).toEqual(first)
    expect(calls).toBe(1)
  })

  it('getDocument 返回 Markdown 全文', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: INFO_BODY })),
    })
    const doc = await client.getDocument('doc-1')
    expect(doc).toMatchObject({ id: 'doc-1', title: '部署规范', text: '# 部署\n\n步骤…' })
  })

  it('401 映射为 auth 错误', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 401, body: { ok: false } })),
    })
    await expect(client.searchDocuments('x', 1)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('404 映射为 not-found 错误', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 404, body: {} })),
    })
    await expect(client.getDocument('nope')).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('429 映射为 rate-limited 错误', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 429, body: {} })),
    })
    await expect(client.searchDocuments('x', 1)).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('网络失败映射为 network 错误', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
    })
    await expect(client.searchDocuments('x', 1)).rejects.toMatchObject({ kind: 'network' })
  })

  it('响应缺 data 字段抛 invalid-response', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: { nope: 1 } })),
    })
    await expect(client.getDocument('x')).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('OutlineApiError 是 Error 实例', () => {
    const err = new OutlineApiError('network', 'boom')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('boom')
  })

  it('listCollections 映射集合字段', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({
        status: 200,
        body: { data: [{ id: 'col-1', name: '测试集合', permission: 'read_write', documentCount: 42 }] },
      })),
    })
    const collections = await client.listCollections()
    expect(collections).toEqual([{ id: 'col-1', name: '测试集合', permission: 'read_write', documentCount: 42 }])
  })

  it('createDocument 默认 publish=true 且 URL 绝对化', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        expect(url).toBe('https://outline.example.com/api/documents.create')
        expect(JSON.parse(String(init.body))).toEqual({ collectionId: 'col-1', title: 'T', text: 'B', publish: true })
        return { status: 200, body: { data: { id: 'd1', title: 'T', url: '/doc/d1', published: true } } }
      }),
    })
    const doc = await client.createDocument({ collectionId: 'col-1', title: 'T', text: 'B' })
    expect(doc).toMatchObject({ id: 'd1', url: 'https://outline.example.com/doc/d1', published: true })
  })

  it('createDocument 支持 publish=false 存草稿', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({ publish: false })
        return { status: 200, body: { data: { id: 'd2', title: 'D', url: '/doc/d2', published: false } } }
      }),
    })
    const doc = await client.createDocument({ collectionId: 'col-1', title: 'D', text: 'B', publish: false })
    expect(doc.published).toBe(false)
  })

  it('createDocument 403 映射为 auth 错误', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 403, body: { ok: false } })),
    })
    await expect(client.createDocument({ collectionId: 'c', title: 'T', text: 'B' }))
      .rejects.toMatchObject({ kind: 'auth' })
  })

  it('updateDocument 携带 id 与变更字段', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        expect(url).toBe('https://outline.example.com/api/documents.update')
        expect(JSON.parse(String(init.body))).toEqual({ id: 'd1', title: '新标题' })
        return { status: 200, body: { data: { id: 'd1', title: '新标题', url: '/doc/d1', published: true } } }
      }),
    })
    const doc = await client.updateDocument('d1', { title: '新标题' })
    expect(doc).toMatchObject({ id: 'd1', title: '新标题', url: 'https://outline.example.com/doc/d1' })
  })

  it('updateDocument 追加语义双发 append + editMode（兼容 Outline 1.9 前后）', async () => {
    // v0.79~v1.8 只认 append（editMode 被丢弃）；v1.9+ 认 editMode（append 由服务端转换后删除）。
    // 只发其中一个都会在某个版本区间退化成「整篇覆盖」，因此必须同时发。
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ id: 'd1', text: '追加段', append: true, editMode: 'append' })
        return { status: 200, body: { data: { id: 'd1', title: 'T', url: '/doc/d1', published: true } } }
      }),
    })
    await client.updateDocument('d1', { text: '追加段', append: true })
  })

  it('updateDocument 透传 publish（发布/转草稿）', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ id: 'd1', publish: false })
        return { status: 200, body: { data: { id: 'd1', title: 'T', url: '/doc/d1', published: false } } }
      }),
    })
    const doc = await client.updateDocument('d1', { publish: false })
    expect(doc.published).toBe(false)
  })

  it('updateDocument 无任何有效变更 → 抛错且不发请求（不做"空更新"）', async () => {
    let called = false
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => { called = true; return { status: 200, body: { data: {} } } }),
    })
    await expect(client.updateDocument('d1', {})).rejects.toThrow('至少需要')
    expect(called).toBe(false)
  })

  it('实例未返回 published 时不臆造（create/update 均缺省而非 true）', async () => {
    const noshape = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 200, body: { data: { id: 'd1', title: 'T', url: '/doc/d1' } } })),
    })
    expect((await noshape.createDocument({ collectionId: 'c1', title: 'T', text: 'x' })).published).toBeUndefined()
    expect((await noshape.updateDocument('d1', { title: 'T2' })).published).toBeUndefined()
  })

  it('getDocument(force) 跳过 60s 缓存，并把新值写回缓存', async () => {
    let info = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => {
        info += 1
        return { status: 200, body: { data: { id: 'd1', title: `第${info}次`, url: '/doc/d1', text: 'x', updatedAt: '' } } }
      }),
    })
    expect((await client.getDocument('d1')).title).toBe('第1次')
    expect((await client.getDocument('d1')).title).toBe('第1次') // 命中缓存
    expect(info).toBe(1)
    expect((await client.getDocument('d1', true)).title).toBe('第2次') // 强制刷新
    expect(info).toBe(2)
    expect((await client.getDocument('d1')).title).toBe('第2次') // 新值已写回缓存
    expect(info).toBe(2)
  })

  it('resolveDocumentPath(force) 逐级取最新名字（写入守卫不用旧名做白名单匹配）', async () => {
    let info = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (String(url).includes('/api/collections.list')) {
          return { status: 200, body: { data: [{ id: 'col-1', name: '集合A', permission: 'read_write' }], pagination: { total: 1 } } }
        }
        info += 1
        return { status: 200, body: { data: { id: 'd1', title: `目录第${info}次`, url: '/doc/d1', text: 'x', updatedAt: '', collectionId: 'col-1' } } }
      }),
    })
    expect(await client.resolveDocumentPath('d1')).toEqual(['集合A', '目录第1次'])
    expect(await client.resolveDocumentPath('d1')).toEqual(['集合A', '目录第1次'])
    expect(info).toBe(1)
    expect(await client.resolveDocumentPath('d1', true)).toEqual(['集合A', '目录第2次'])
    expect(info).toBe(2)
  })

  it('deleteDocument 调用删除端点', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        expect(url).toBe('https://outline.example.com/api/documents.delete')
        expect(JSON.parse(String(init.body))).toEqual({ id: 'd1' })
        return { status: 200, body: { data: { id: 'd1', success: true } } }
      }),
    })
    expect(await client.deleteDocument('d1')).toEqual({ success: true })
  })

  it('searchDocuments 在老实例上把 updatedAfter 降级为本地筛选', async () => {
    // 老实例（Outline <= 1.11）没有 filters：探测请求的 filters 被丢弃，返回全库真实总数。
    const bodies: any[] = []
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        bodies.push(JSON.parse(String(init.body)))
        if (String(url).includes('/api/documents.list')) {
          return { status: 200, body: { data: [{ id: 'x' }], pagination: { total: 37 } } }
        }
        return {
          status: 200,
          body: {
            data: [
              { context: '新', document: { id: 'new', title: '新文档', url: '/d/new', collectionId: 'c1', updatedAt: '2026-09-01T00:00:00Z' } },
              { context: '旧', document: { id: 'old', title: '旧文档', url: '/d/old', collectionId: 'c1', updatedAt: '2026-01-01T00:00:00Z' } },
            ],
            pagination: { total: 2 },
          },
        }
      }),
    })
    const r = await client.searchDocuments('x', 5, 'c1', { userId: 'u1', updatedAfter: '2026-08-01' })
    expect(r.timeFilterMode).toBe('client')
    expect(r.hits.map((h) => h.id)).toEqual(['new'])
    // 搜索请求仍走各版本都认的顶层参数，且不再发那个服务端从未支持的 updatedAfter
    const searchBody = bodies.find((b) => b.query === 'x')
    expect(searchBody).toEqual({ query: 'x', limit: 5, collectionId: 'c1', userId: 'u1' })
    expect(searchBody.updatedAfter).toBeUndefined()
  })

  it('searchDocuments 在新实例上用 filters 数组服务端过滤（旧参数全部搬进去）', async () => {
    // 新实例（1.12+）：探测带 filters 且是未来时间 → total=0；全库计数 → 12。
    const bodies: any[] = []
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        if (String(url).includes('/api/documents.list')) {
          return { status: 200, body: { data: [], pagination: { total: body.filters !== undefined ? 0 : 12 } } }
        }
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    const r = await client.searchDocuments('x', 5, 'c1', { userId: 'u1', updatedAfter: '2026-08-01' })
    expect(r.timeFilterMode).toBe('server')
    const searchBody = bodies.find((b) => b.query === 'x')
    expect(searchBody).toEqual({
      query: 'x',
      limit: 5,
      filters: [
        { field: 'collectionId', operator: 'eq', value: 'c1' },
        { field: 'userId', operator: 'eq', value: 'u1' },
        { field: 'updatedAt', operator: 'gte', value: '2026-08-01' },
      ],
    })
    // 与服务端旧参数互斥：同时出现会被 400 拒绝
    expect(searchBody.collectionId).toBeUndefined()
    expect(searchBody.userId).toBeUndefined()
  })

  it('探测被服务端 400 拒绝时判定为不支持 filters，回退顶层参数', async () => {
    let searchBody: any
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        if (String(url).includes('/api/documents.list')) {
          return { status: 400, body: { ok: false, error: 'Invalid input' } }
        }
        searchBody = JSON.parse(String(init.body))
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    const r = await client.searchDocuments('x', 5, undefined, { updatedAfter: '2026-08-01' })
    expect(r.timeFilterMode).toBe('client')
    expect(searchBody).toEqual({ query: 'x', limit: 5 })
  })

  it('探测遇网络故障时向上抛，不把实例永久判成不支持 filters', async () => {
    // 宽 catch 会把「连不上」固化成「这实例没有 filters 能力」，之后永远走本地筛选。
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (String(url).includes('/api/documents.list')) throw new Error('ECONNRESET')
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    await expect(client.searchDocuments('x', 5, undefined, { updatedAfter: '2026-08-01' })).rejects.toThrow(/无法连接|ECONNRESET/)
  })

  it('updatedAfter 无法解析时直接报错，不发请求', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => {
        calls += 1
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    await expect(client.searchDocuments('x', 5, undefined, { updatedAfter: '上周' })).rejects.toThrow(/不是可解析的时间/)
    expect(calls).toBe(0)
  })

  it('不带 updatedAfter 的普通搜索不触发能力探测（零额外请求）', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => {
        calls += 1
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    await client.searchDocuments('x', 5)
    expect(calls).toBe(1)
  })

  it('searchDocuments 支持 collectionId 过滤并映射 parentDocumentId', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ query: 'x', limit: 5, collectionId: 'col-1' })
        return {
          status: 200,
          body: {
            data: [{ context: '', document: { id: 'd', title: 'T', url: '/doc/d', collectionId: 'col-1', parentDocumentId: 'p-1', updatedAt: '' } }],
            pagination: { total: 1 },
          },
        }
      }),
    })
    const { hits } = await client.searchDocuments('x', 5, 'col-1')
    expect(hits[0].parentDocumentId).toBe('p-1')
  })

  it('resolveDocumentPath 沿父链解析完整路径（含集合名）', async () => {
    const docs = new Map<string, any>([
      ['leaf', { id: 'leaf', title: '叶子', url: '/doc/leaf', text: '', updatedAt: '', collectionId: 'col-1', parentDocumentId: 'mid' }],
      ['mid', { id: 'mid', title: '中层', url: '/doc/mid', text: '', updatedAt: '', collectionId: 'col-1', parentDocumentId: 'root' }],
      ['root', { id: 'root', title: '根目录', url: '/doc/root', text: '', updatedAt: '', collectionId: 'col-1' }],
    ])
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        if (String(url).includes('/api/collections.list')) {
          return { status: 200, body: { data: [{ id: 'col-1', name: '集合A', permission: 'read_write' }] } }
        }
        const body = JSON.parse(String(init.body)) as { id?: string }
        const doc = docs.get(body.id ?? '')
        return doc === undefined
          ? { status: 404, body: {} }
          : { status: 200, body: { data: doc } }
      }),
    })
    const path = await client.resolveDocumentPath('leaf')
    expect(path).toEqual(['集合A', '根目录', '中层', '叶子'])
  })

  it('searchDocuments 透传 offset 用于翻页', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ query: 'x', limit: 5, offset: 10 })
        return { status: 200, body: { data: [], pagination: { total: 0 } } }
      }),
    })
    const r = await client.searchDocuments('x', 5, undefined, undefined, 10)
    expect(r.total).toBe(0)
  })

  it('listCollections 翻页收齐全部集合', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        calls += 1
        const offset = Number(new URL(String(url)).searchParams.get('offset') ?? '0')
        if (offset === 0) {
          return { status: 200, body: { data: [
            { id: 'c1', name: '集合A', permission: 'read_write' },
            { id: 'c2', name: '集合B', permission: 'read_write' },
          ], pagination: { total: 3 } } }
        }
        return { status: 200, body: { data: [{ id: 'c3', name: '集合C', permission: 'read' }], pagination: { total: 3 } } }
      }),
    })
    const collections = await client.listCollections()
    expect(collections).toHaveLength(3)
    expect(collections[2].name).toBe('集合C')
    expect(calls).toBe(2)
  })

  it('listChildDocuments 翻页收齐全部子文档', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (_url, init) => {
        calls += 1
        const body = JSON.parse(String(init.body)) as { offset?: number }
        if (!body.offset) {
          return { status: 200, body: { data: [
            { id: 'd1', title: '子1', url: '/doc/d1', collectionId: 'c', updatedAt: '' },
            { id: 'd2', title: '子2', url: '/doc/d2', collectionId: 'c', updatedAt: '' },
          ], pagination: { total: 3 } } }
        }
        return { status: 200, body: { data: [{ id: 'd3', title: '子3', url: '/doc/d3', collectionId: 'c', updatedAt: '' }], pagination: { total: 3 } } }
      }),
    })
    const hits = await client.listChildDocuments('parent-1')
    expect(hits).toHaveLength(3)
    expect(hits[2].id).toBe('d3')
    expect(calls).toBe(2)
  })

  it('updateDocument 后清除文档缓存与集合缓存', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url, init) => {
        calls += 1
        if (String(url).includes('/api/documents.update')) {
          return { status: 200, body: { data: { id: 'd1', title: '新标题', url: '/doc/d1', published: true } } }
        }
        if (String(url).includes('/api/collections.list')) {
          return { status: 200, body: { data: [{ id: 'col-1', name: '集合A', permission: 'read_write' }], pagination: { total: 1 } } }
        }
        return { status: 200, body: { data: { id: 'd1', title: '新标题', url: '/doc/d1', text: 'body', updatedAt: '' } } }
      }),
    })
    await client.getDocument('d1') // 写入文档缓存
    await client.listCollections() // 写入集合缓存
    await client.updateDocument('d1', { title: '新标题' })
    await client.getDocument('d1') // 文档缓存已失效 → 重新请求（call 4）
    const collections = await client.listCollections() // 集合缓存已失效 → 重新请求（call 5）
    expect(calls).toBe(5)
    expect(collections).toHaveLength(1)
  })

  it('deleteDocument 后清除文档缓存', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        calls += 1
        if (String(url).includes('/api/documents.delete')) {
          return { status: 200, body: { data: { id: 'd1', success: true } } }
        }
        return { status: 200, body: { data: { id: 'd1', title: 'T', url: '/doc/d1', text: 'body', updatedAt: '' } } }
      }),
    })
    await client.getDocument('d1')
    await client.deleteDocument('d1')
    await client.getDocument('d1')
    expect(calls).toBe(3)
  })

  it('429 限流自动重试成功后返回结果', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => {
        calls += 1
        if (calls <= 2) return { status: 429, body: { ok: false }, headers: { 'retry-after': '0' } }
        return { status: 200, body: SEARCH_BODY }
      }),
    })
    const { total } = await client.searchDocuments('部署', 5)
    expect(total).toBe(1)
    expect(calls).toBe(3)
  })

  it('429 超过重试次数仍抛 rate-limited', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({ status: 429, body: {}, headers: { 'retry-after': '0' } })),
    })
    await expect(client.searchDocuments('x', 1)).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('拒绝公网明文 http（https 校验）', () => {
    expect(() => new OutlineClient({ baseUrl: 'http://outline.example.com', apiToken: 'tok' })).toThrow('非 HTTPS')
    expect(() => new OutlineClient({ baseUrl: 'http://example.com', apiToken: 'tok' })).toThrow('非 HTTPS')
  })

  it('允许 https 地址', () => {
    expect(() => new OutlineClient({ baseUrl: 'https://outline.example.com', apiToken: 'tok' })).not.toThrow()
  })

  it('允许 localhost / 127.0.0.1 / 内网私有地址的 http', () => {
    expect(() => new OutlineClient({ baseUrl: 'http://127.0.0.1:3000', apiToken: 'tok' })).not.toThrow()
    expect(() => new OutlineClient({ baseUrl: 'http://localhost:3000', apiToken: 'tok' })).not.toThrow()
    expect(() => new OutlineClient({ baseUrl: 'http://10.0.0.5', apiToken: 'tok' })).not.toThrow()
    expect(() => new OutlineClient({ baseUrl: 'http://172.16.0.1', apiToken: 'tok' })).not.toThrow()
    expect(() => new OutlineClient({ baseUrl: 'http://192.168.1.10', apiToken: 'tok' })).not.toThrow()
  })

  it('cacheTtlMs 控制缓存有效期（过期后重新请求）', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      cacheTtlMs: 5,
      fetchImpl: stubFetch(async () => { calls += 1; return { status: 200, body: INFO_BODY } }),
    })
    await client.getDocument('doc-1')
    await client.getDocument('doc-1') // 未过期 → 命中缓存
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await client.getDocument('doc-1') // 已过期 → 重新请求
    expect(calls).toBe(2)
  })

  it('listUsers 分页拉齐 users.list 全部成员', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (!url.includes('users.list')) throw new Error(`unexpected url ${url}`)
        if (url.includes('offset=0')) {
          return { status: 200, body: { data: Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, name: `用户${i}` })), pagination: { total: 101 } } }
        }
        return { status: 200, body: { data: [{ id: 'u100', name: '用户100', email: 'a@b.c' }], pagination: { total: 101 } } }
      }),
    })
    const users = await client.listUsers()
    expect(users).toHaveLength(101)
    expect(users[100]).toMatchObject({ id: 'u100', name: '用户100', email: 'a@b.c' })
  })

  it('findUsers 先精确后模糊（不区分大小写，含邮箱）', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async () => ({
        status: 200,
        body: { data: [
          { id: 'u1', name: '张三' },
          { id: 'u2', name: '张三丰' },
          { id: 'u3', name: 'Li Si', email: 'lisi@example.com' },
        ], pagination: { total: 3 } },
      })),
    })
    expect(await client.findUsers('张三')).toHaveLength(1) // 精确唯一
    expect((await client.findUsers('张三'))[0]!.id).toBe('u1')
    expect(await client.findUsers('张')).toHaveLength(2) // 子串两人
    expect((await client.findUsers('lisi'))[0]!.id).toBe('u3') // 邮箱大小写不敏感
    expect(await client.findUsers('不存在')).toHaveLength(0)
  })

  it('searchDocuments 把 document.user.id 映射为 authorName；users.list 失败时降级不阻断', async () => {
    const withUsers = {
      data: [{ document: { id: 'd1', title: 'T', url: '/d', collectionId: 'c', updatedAt: '', user: { id: 'u1', name: '张三' } }, context: '' }],
      pagination: { total: 1 },
    }
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (url.includes('users.list')) return { status: 200, body: { data: [{ id: 'u1', name: '张三' }], pagination: { total: 1 } } }
        return { status: 200, body: withUsers }
      }),
    })
    const { hits } = await client.searchDocuments('x', 5)
    expect(hits[0]!.authorName).toBe('张三')
  })

  it('searchDocuments 在 users.list 不可用时仍返回结果（authorName 缺省）', async () => {
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (url.includes('users.list')) return { status: 403, body: { message: 'forbidden' } }
        return { status: 200, body: {
          data: [{ document: { id: 'd1', title: 'T', url: '/d', collectionId: 'c', updatedAt: '', user: { id: 'u1' } }, context: '' }],
          pagination: { total: 1 },
        } }
      }),
    })
    const { hits } = await client.searchDocuments('x', 5)
    expect(hits[0]!.authorName).toBeUndefined()
  })

  it('相同查询命中搜索缓存（不重复打 API）；写操作后缓存失效', async () => {
    let calls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      cacheTtlMs: 5000,
      fetchImpl: stubFetch(async (url) => {
        if (url.includes('users.list')) return { status: 200, body: { data: [], pagination: { total: 0 } } }
        if (url.includes('documents.search')) { calls += 1; return { status: 200, body: { data: [{ document: { id: 'd1', title: 'T', url: '/d', collectionId: 'c', updatedAt: '', user: { id: 'u1' } }, context: '' }], pagination: { total: 1 } } } }
        if (url.includes('documents.create')) return { status: 200, body: { data: { id: 'd2', title: '新', url: '/d2', published: true } } }
        return { status: 200, body: { data: {}, pagination: { total: 0 } } }
      }),
    })
    await client.searchDocuments('缓存测试', 10)
    await client.searchDocuments('缓存测试', 10) // 命中缓存
    expect(calls).toBe(1)
    await client.createDocument({ collectionId: 'c', title: '新', text: 'x' }) // 写 → 缓存失效
    await client.searchDocuments('缓存测试', 10)
    expect(calls).toBe(2)
  })

  it('searchDocuments 优先用响应里的 createdBy.name 作作者名（不再多打一次 users.list）', async () => {
    let usersCalls = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        if (url.includes('users.list')) { usersCalls += 1; return { status: 200, body: { data: [], pagination: { total: 0 } } } }
        return { status: 200, body: {
          data: [{
            context: '片段',
            document: {
              id: 'd1', title: 'T', url: '/d', collectionId: 'c', updatedAt: '',
              createdBy: { id: 'u9', name: '刘艺伟' },
            },
          }],
          pagination: { total: 1 },
        } }
      }),
    })
    const { hits } = await client.searchDocuments('x', 5)
    expect(hits[0]!.authorName).toBe('刘艺伟')
    expect(usersCalls).toBe(0) // 关键：作者名零额外请求
  })

  it('listCollections 多页时并发补齐：顺序与串行一致、不漏项、确实并发', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const client = new OutlineClient({
      baseUrl: 'https://outline.example.com',
      apiToken: 'tok',
      fetchImpl: stubFetch(async (url) => {
        const parsed = new URL(url)
        const offset = Number(parsed.searchParams.get('offset') ?? '0')
        const limit = Number(parsed.searchParams.get('limit') ?? '100')
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        const count = Math.max(0, Math.min(limit, 250 - offset))
        return { status: 200, body: {
          data: Array.from({ length: count }, (_, i) => ({ id: `c${offset + i}`, name: `集合${offset + i}`, permission: 'read' })),
          pagination: { total: 250 },
        } }
      }),
    })
    const collections = await client.listCollections()
    expect(collections).toHaveLength(250)
    expect(collections[0]!.id).toBe('c0')
    expect(collections[249]!.id).toBe('c249') // 顺序未被并发打乱
    expect(maxInFlight).toBeGreaterThan(1) // 确实并发拉页，而不是串行 3 次往返
  })

  it('mapWithConcurrency 保持入参顺序且并发数受上限约束', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, n === 1 ? 8 : 2))
      inFlight -= 1
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]) // 慢任务在前也不改变顺序
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })
})