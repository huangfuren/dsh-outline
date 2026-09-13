import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  outlineSearchTool, outlineGetDocumentTool, outlineCountTool, outlineListCollectionsTool, outlineResolvePathTool,
  outlineCreateTool, outlineUpdateDocumentTool, outlineDeleteTool, outlineListChildrenTool, outlineDocTemplateTool,
  outlineSaveLocalTool, outlineListUsersTool, buildCreateApprovalReason, resolveWriteGuard, resolvePathGuard, parseWritablePaths,
  renderLocalSaveHint, resolveLocalSaveDir, sanitizeFileName, buildSaveFileName, dedupeFileName, documentToMarkdown, mergeDocumentsToMarkdown,
  rerankHits, synonymVariants,
} from '../src/tools.js'
import { OutlineApiError } from '../src/errors.js'
import type { OutlineClient } from '../src/client.js'

function fakeClient(overrides: Partial<OutlineClient> = {}): OutlineClient {
  return {
    searchDocuments: async (query: string) => ({ total: 1, hits: [{ id: 'doc-1', title: query, url: '/d', snippet: 's', collectionId: '', updatedAt: '' }] }),
    getDocument: async (id: string) => ({ id, title: 'T', url: '/d', text: 'body', updatedAt: '' }),
    countDocuments: async () => 42,
    resolveDocumentPath: async (docId: string) => [docId],
    ...overrides,
  } as unknown as OutlineClient
}

const exec = {} as never

describe('outline_search', () => {
  it('execute 返回 {total, hits} 归一化结果', async () => {
    const tool = outlineSearchTool(() => fakeClient(), 10)
    const result = await tool.execute({ query: '部署' }, exec) as any
    expect(result.total).toBe(1)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].id).toBe('doc-1')
  })

  it('limit 超界被钳制', async () => {
    let seen = 0
    const tool = outlineSearchTool(() => fakeClient({ searchDocuments: async (_q, limit) => { seen = limit; return { total: 0, hits: [] } } }), 10)
    await tool.execute({ query: 'x', limit: 999 }, exec)
    expect(seen).toBe(25)
  })

  it('未配置时抛出中文配置错误', async () => {
    const tool = outlineSearchTool(() => { throw new Error('dsh-outline-auto 未配置：…') }, 10)
    await expect(tool.execute({ query: 'x' }, exec)).rejects.toThrow('未配置')
  })

  it('渲染结果时标题特殊字符被转义、含括号 URL 被 <> 包裹', async () => {
    const tool = outlineSearchTool(() => fakeClient(), 10)
    const value = {
      total: 1,
      hits: [{
        id: 'doc-1',
        title: '部署[规范]（测试版）',
        url: 'https://outline.example.com/doc/a(b)',
        snippet: '片段',
        collectionId: 'c',
        updatedAt: '',
      }],
    }
    const rendered = (tool as any).output.render({}, value)
    const text = Array.isArray(rendered) ? rendered.map((r: any) => r.text).join('\n') : String(rendered)
    expect(text).toContain('[部署\\[规范\\]（测试版）](<https://outline.example.com/doc/a(b)>)')
  })
})

describe('outline_count', () => {
  it('execute 返回文档总数', async () => {
    const tool = outlineCountTool(() => fakeClient())
    const result = await tool.execute({} as never, exec) as any
    expect(result.total).toBe(42)
  })
})

describe('outline_list_collections', () => {
  it('execute 返回集合列表', async () => {
    const tool = outlineListCollectionsTool(() => fakeClient({ listCollections: async () => [{ id: 'col-1', name: '测试集合', permission: 'read_write', documentCount: 42 }] }))
    const result = await tool.execute({} as never, exec) as any
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('col-1')
  })
})

describe('outline_create', () => {
  it('execute 传入参数并返回结果（目标在白名单内）', async () => {
    let seen: any
    const tool = outlineCreateTool(() => fakeClient({
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      resolveDocumentPath: async () => ['集合A', '父目录'],
      createDocument: async (input) => { seen = input; return { id: 'd1', url: 'https://outline.example.com/doc/d1', title: input.title, published: true } },
    }), () => '集合A')
    const result = await tool.execute({ collectionId: 'col-1', title: 'T', text: 'B', parentDocumentId: 'parent-1' }, exec) as any
    expect(seen).toEqual({ collectionId: 'col-1', parentDocumentId: 'parent-1', title: 'T', text: 'B', publish: undefined })
    expect(result.url).toContain('doc/d1')
  })

  it('未配置白名单时拒绝（只读模式，连审批都不弹）', async () => {
    const tool = outlineCreateTool(() => fakeClient({ listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }] }), () => '')
    await expect(tool.execute({ collectionId: 'col-1', title: 'T', text: 'B' }, exec)).rejects.toThrow('只读模式')
  })

  it('目标集合不存在时拒绝（失败关闭）', async () => {
    const tool = outlineCreateTool(() => fakeClient({ listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }] }), () => '集合A')
    await expect(tool.execute({ collectionId: 'col-9', title: 'T', text: 'B' }, exec)).rejects.toThrow('无法确认写入目标集合')
  })

  it('目标在白名单外时拒绝', async () => {
    const tool = outlineCreateTool(() => fakeClient({ listCollections: async () => [{ id: 'col-2', name: '其它集合', permission: 'read_write' }] }), () => '集合A')
    await expect(tool.execute({ collectionId: 'col-2', title: 'T', text: 'B' }, exec)).rejects.toThrow('不在可写目录内')
  })
})

describe('parseWritablePaths', () => {
  it('空串解析为空列表', () => {
    expect(parseWritablePaths('')).toEqual([])
    expect(parseWritablePaths('  ,,  ')).toEqual([])
  })
  it('解析集合级条目', () => {
    expect(parseWritablePaths(' 集合A ')).toEqual([{ collectionName: '集合A', segments: [] }])
  })
  it('解析目录级条目（逗号分隔）', () => {
    expect(parseWritablePaths('集合A,集合B/目录1/子目录2')).toEqual([
      { collectionName: '集合A', segments: [] },
      { collectionName: '集合B', segments: ['目录1', '子目录2'] },
    ])
  })
  it('过滤空白段', () => {
    expect(parseWritablePaths('集合A/目录1,,集合B/ /目录2')).toEqual([
      { collectionName: '集合A', segments: ['目录1'] },
      { collectionName: '集合B', segments: ['目录2'] },
    ])
  })
})

describe('resolvePathGuard', () => {
  const collections = [
    { id: 'col-1', name: '集合A', permission: 'read_write' },
    { id: 'col-2', name: '集合B', permission: 'read_write' },
  ]

  it('白名单为空 → 只读模式拒绝', async () => {
    const err = await resolvePathGuard(fakeClient(), { kind: 'create', collectionId: 'col-1' }, [], collections)
    expect(err).toContain('只读模式')
  })

  it('集合级白名单放行集合根级创建', async () => {
    const err = await resolvePathGuard(fakeClient(), { kind: 'create', collectionId: 'col-1' }, parseWritablePaths('集合A'), collections)
    expect(err).toBeNull()
  })

  it('集合级白名单放行目录内任意层级（create 父目录）', async () => {
    const client = fakeClient({ resolveDocumentPath: async () => ['集合A', '目录1', '子目录'] })
    const err = await resolvePathGuard(client, { kind: 'create', collectionId: 'col-1', parentDocumentId: 'p' }, parseWritablePaths('集合A'), collections)
    expect(err).toBeNull()
  })

  it('目录级白名单前缀匹配（doc 目标含全部子级）', async () => {
    const client = fakeClient({ resolveDocumentPath: async () => ['集合A', '目录1', '子目录', '文档X'] })
    const err = await resolvePathGuard(client, { kind: 'doc', docId: 'd' }, parseWritablePaths('集合A/目录1'), collections)
    expect(err).toBeNull()
  })

  it('目录级白名单不匹配兄弟目录', async () => {
    const client = fakeClient({ resolveDocumentPath: async () => ['集合A', '目录2', '文档X'] })
    const err = await resolvePathGuard(client, { kind: 'doc', docId: 'd' }, parseWritablePaths('集合A/目录1'), collections)
    expect(err).toContain('不在可写目录内')
  })

  it('集合不匹配时拒绝', async () => {
    const client = fakeClient({ resolveDocumentPath: async () => ['集合B', '文档X'] })
    const err = await resolvePathGuard(client, { kind: 'doc', docId: 'd' }, parseWritablePaths('集合A'), collections)
    expect(err).toContain('不在可写目录内')
  })

  it('create 目标集合不存在 → 拒绝（失败关闭）', async () => {
    const err = await resolvePathGuard(fakeClient(), { kind: 'create', collectionId: 'col-9' }, parseWritablePaths('集合A'), collections)
    expect(err).toContain('无法确认写入目标集合')
  })

  it('目标路径解析失败 → 拒绝', async () => {
    const client = fakeClient({ resolveDocumentPath: async () => { throw new Error('boom') } })
    const err = await resolvePathGuard(client, { kind: 'doc', docId: 'd' }, parseWritablePaths('集合A'), collections)
    expect(err).toContain('无法解析写入目标路径')
  })
})

describe('resolveWriteGuard', () => {
  it('普通集合放行', () => {
    expect(resolveWriteGuard([{ id: 'c2', name: '测试集合', permission: 'read_write' }], 'c2')).toBeNull()
  })
  it('集合不可确认时拒绝写入（失败关闭）', () => {
    expect(resolveWriteGuard([], 'c9')).toContain('无法确认')
  })
  it('只读权限集合拒绝写入', () => {
    expect(resolveWriteGuard([{ id: 'c3', name: '只读集合', permission: 'read_only' }], 'c3')).toContain('禁止')
  })
})

describe('outline_resolve_path', () => {
  it('解析 集合/目录1/目录2 路径', async () => {
    const tool = outlineResolvePathTool(() => fakeClient({
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      searchDocuments: async (q: string, _l: number, collectionId?: string) => {
        if (q === '目录1') return { total: 1, hits: [{ id: 'root-1', title: '目录1', url: '/d', snippet: '', collectionId: collectionId ?? 'col-1', updatedAt: '' }] }
        return { total: 0, hits: [] }
      },
      listChildDocuments: async (parentId: string) => parentId === 'root-1'
        ? [{ id: 'leaf-1', title: '子目录-2', url: '/d', snippet: '', collectionId: 'col-1', updatedAt: '', parentDocumentId: 'root-1' }]
        : [],
    }))
    const result = await tool.execute({ path: '集合A/目录1/子目录2' }, exec) as any
    expect(result).toMatchObject({ collectionId: 'col-1', parentDocumentId: 'leaf-1', path: ['集合A', '目录1', '子目录-2'] })
  })

  it('集合不存在时报错并列出候选', async () => {
    const tool = outlineResolvePathTool(() => fakeClient({ listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }] }))
    await expect(tool.execute({ path: '不存在的集合/x' }, exec)).rejects.toThrow('找不到集合')
  })

  it('子目录找不到时报错', async () => {
    const tool = outlineResolvePathTool(() => fakeClient({
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      searchDocuments: async () => ({ total: 0, hits: [] }),
    }))
    await expect(tool.execute({ path: '集合A/不存在的目录' }, exec)).rejects.toThrow('找不到')
  })
})

describe('outline_search 过滤', () => {
  it('透传 collectionId/userId/updatedAfter', async () => {
    let seen: any
    const tool = outlineSearchTool(() => fakeClient({ searchDocuments: async (q, l, coll, filters) => { seen = { q, l, coll, filters }; return { total: 0, hits: [] } } }), 10)
    await tool.execute({ query: 'x', collectionId: 'c1', userId: 'u1', updatedAfter: '2026-08-01' }, exec)
    expect(seen).toEqual({ q: 'x', l: 10, coll: 'c1', filters: { userId: 'u1', updatedAfter: '2026-08-01' } })
  })

  it('透传 offset 翻页参数', async () => {
    let seen: any
    const tool = outlineSearchTool(() => fakeClient({ searchDocuments: async (q, l, coll, filters, offset) => { seen = { q, l, coll, filters, offset }; return { total: 0, hits: [] } } }), 10)
    await tool.execute({ query: 'x', offset: 25 }, exec)
    expect(seen).toEqual({ q: 'x', l: 10, coll: undefined, filters: { userId: undefined, updatedAfter: undefined }, offset: 25 })
  })
})

describe('outline_update_document', () => {
  it('更新标题并传参（目标在白名单内）', async () => {
    let seen: any
    const tool = outlineUpdateDocumentTool(() => fakeClient({
      getDocument: async () => ({ id: 'd1', title: '旧', url: '/d', text: 'x', updatedAt: '', collectionId: 'col-1' }),
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      resolveDocumentPath: async () => ['集合A', '旧文档'],
      updateDocument: async (id, input) => { seen = { id, ...input }; return { id, url: '/doc/d1', title: input.title ?? '旧', published: true } },
    }), () => '集合A')
    const r = await tool.execute({ id: 'd1', title: '新标题' }, exec) as any
    expect(seen).toEqual({ id: 'd1', title: '新标题' })
    expect(r.title).toBe('新标题')
  })
  it('未配置白名单时拒绝更新（只读模式）', async () => {
    const tool = outlineUpdateDocumentTool(() => fakeClient({
      getDocument: async () => ({ id: 'd1', title: 'T', url: '/d', text: 'x', updatedAt: '', collectionId: 'col-1' }),
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      resolveDocumentPath: async () => ['集合A', 'T'],
    }), () => '')
    await expect(tool.execute({ id: 'd1', text: 'x' }, exec)).rejects.toThrow('只读模式')
  })
  it('目标在白名单外时拒绝更新', async () => {
    const tool = outlineUpdateDocumentTool(() => fakeClient({
      getDocument: async () => ({ id: 'd1', title: 'T', url: '/d', text: 'x', updatedAt: '', collectionId: 'col-2' }),
      listCollections: async () => [{ id: 'col-2', name: '其它集合', permission: 'read_write' }],
      resolveDocumentPath: async () => ['其它集合', 'T'],
    }), () => '集合A')
    await expect(tool.execute({ id: 'd1', text: 'x' }, exec)).rejects.toThrow('不在可写目录内')
  })
  // 参数校验在 pre-execute 前置拦截；execute 内仍保留 fail-closed 兜底。
  it('至少需要 title 或 text', async () => {
    const tool = outlineUpdateDocumentTool(() => fakeClient(), () => '集合A')
    await expect(tool.execute({ id: 'd1' }, exec)).rejects.toThrow('至少需要')
  })
})

describe('outline_delete', () => {
  it('第二道审批通过后删除', async () => {
    let asked = ''
    const tool = outlineDeleteTool(() => fakeClient({
      getDocument: async () => ({ id: 'd1', title: 'T', url: '/d', text: 'x', updatedAt: '', collectionId: 'col-1' }),
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      resolveDocumentPath: async () => ['集合A', 'T'],
      deleteDocument: async () => ({ success: true }),
    }), () => '集合A', async (reason, _exec) => { asked = reason; return true })
    const r = await tool.execute({ id: 'd1' }, exec) as any
    expect(asked).toContain('再次确认')
    expect(r.success).toBe(true)
  })
  it('第二道审批拒绝则取消删除', async () => {
    const tool = outlineDeleteTool(() => fakeClient({
      getDocument: async () => ({ id: 'd1', title: 'T', url: '/d', text: 'x', updatedAt: '', collectionId: 'col-1' }),
      listCollections: async () => [{ id: 'col-1', name: '集合A', permission: 'read_write' }],
      resolveDocumentPath: async () => ['集合A', 'T'],
    }), () => '集合A', async () => false)
    await expect(tool.execute({ id: 'd1' }, exec)).rejects.toThrow('取消')
  })
})

describe('outline_doc_template', () => {
  it('返回需求文档模板且包含全部章节', async () => {
    const tool = outlineDocTemplateTool()
    const r = await tool.execute({} as never, exec) as any
    for (const s of ['【需求或目标】', '【交付物】', '【交付标准】', '【交付时间】', '【潜在风险点】', '【解决的问题】', '【工作思路】', '【备注】', '当前状态']) {
      expect(r.template).toContain(s)
    }
    expect(r.sections).toContain('需求或目标')
    expect(r.sections).toContain('潜在风险点')
    expect(r.sections).toContain('备注')
  })

  it('条目类章节示范一点一行、逐条编号的排版（防挤成一段）', async () => {
    const tool = outlineDocTemplateTool()
    const r = await tool.execute({} as never, exec) as any
    // 【交付物】 下必须出现逐条编号的行（1、<交付物 1> 换行 2、…）
    expect(r.template).toMatch(/【交付物】[^\n]*\n1、<交付物 1>\n2、<交付物 2>\n3、<交付物 3>/)
    expect(r.template).toMatch(/【工作思路】[^\n]*\n1\. <第一步>\n2\. <第二步>\n3\. <第三步>/)
    expect(r.template).toMatch(/【潜在风险点】[^\n]*\n1、<风险 1>\n2、<风险 2>/)
  })
})

describe('输出 schema 完整性（回归：parentDocumentId 等字段必须声明，避免被 additionalProperties:false 剥离）', () => {
  it('search/get_document/list_children schema 声明 parentDocumentId/collectionId', () => {
    const search = (outlineSearchTool(() => fakeClient(), 10) as any).output.schema
    expect(search.properties.hits.items.properties.parentDocumentId).toBeDefined()
    const get = (outlineGetDocumentTool(() => fakeClient()) as any).output.schema
    expect(get.properties.collectionId).toBeDefined()
    expect(get.properties.parentDocumentId).toBeDefined()
    const children = (outlineListChildrenTool(() => fakeClient()) as any).output.schema
    expect(children.items.properties.parentDocumentId).toBeDefined()
    expect(children.items.properties.snippet).toBeDefined()
  })
})

describe('outline_list_children', () => {
  it('返回子文档', async () => {
    const tool = outlineListChildrenTool(() => fakeClient({ listChildDocuments: async () => [{ id: 'c1', title: '子', url: '/d', snippet: '', collectionId: 'col-1', updatedAt: '' }] }))
    const r = await tool.execute({ parentId: 'p' }, exec) as any
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('子')
  })
})

describe('buildCreateApprovalReason', () => {
  it('包含集合名、标题与内容预览', () => {
    const reason = buildCreateApprovalReason({ collectionId: 'col-1', title: '测试文档', text: '第一行内容，用于预览。' + '长'.repeat(200) }, '集合A')
    expect(reason).toContain('集合A')
    expect(reason).toContain('测试文档')
    expect(reason).toContain('…')
    expect(reason.length).toBeLessThan(300)
  })
  it('集合名缺失时回退 collectionId', () => {
    expect(buildCreateApprovalReason({ collectionId: 'col-9', title: 'T' })).toContain('col-9')
  })
})

describe('outline_get_document', () => {
  it('execute 返回全文并按 maxLength 截断', async () => {
    const tool = outlineGetDocumentTool(() => fakeClient({ getDocument: async () => ({ id: 'd', title: 'T', url: '/d', text: 'a'.repeat(3000), updatedAt: '' }) }))
    const result = await tool.execute({ id: 'd', maxLength: 1000 }, exec) as any
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(1000)
  })

  it('文档缺失透传 not-found 错误', async () => {
    const tool = outlineGetDocumentTool(() => fakeClient({ getDocument: async () => { throw new OutlineApiError('not-found', 'Outline 文档不存在或无权访问（HTTP 404）：请确认文档 id 是否正确。', 404) } }))
    await expect(tool.execute({ id: 'nope' }, exec)).rejects.toMatchObject({ kind: 'not-found' })
  })
})

// ---------------------------------------------------------------------------
// 本地保存：提示语、文件名、去重、outline_save_local
// ---------------------------------------------------------------------------

describe('resolveLocalSaveDir', () => {
  it('配置优先', () => {
    expect(resolveLocalSaveDir('D:\\somewhere', {})).toBe('D:\\somewhere')
  })
  it('留空回退 DSH_HOME/outline-auto-saves', () => {
    const r = resolveLocalSaveDir('', { DSH_HOME: '/dsh' })
    expect(r).toContain('outline-auto-saves')
    expect(r).toContain('dsh')
  })
  it('无 DSH_HOME 时回退 HOME', () => {
    const r = resolveLocalSaveDir(undefined, { HOME: '/home/u' })
    expect(r).toContain('outline-auto-saves')
    expect(r).toContain('home')
    expect(r).toContain('u')
  })
})

describe('renderLocalSaveHint', () => {
  it('已配置目录：提示回复"保存"并给出存放位置', () => {
    const hint = renderLocalSaveHint('D:\\notes', 'search')
    expect(hint).toContain('是否将本次搜索结果整理成文档存放在本地')
    expect(hint).toContain('D:\\notes')
  })
  it('文档形态提示语用"本文档"', () => {
    expect(renderLocalSaveHint('/tmp/x', 'document')).toContain('本文档')
  })
  it('未配置目录：提示先配置，不出现路径', () => {
    const hint = renderLocalSaveHint('', 'search')
    expect(hint).toContain('设置 → 插件 → 插件配置')
    expect(hint).not.toMatch(/存入 \S/)
  })
})

describe('outline_list_users', () => {
  it('execute 返回用户列表', async () => {
    const tool = outlineListUsersTool(() => fakeClient({
      listUsers: async () => [{ id: 'u1', name: '张三', email: 'z@x.com' }, { id: 'u2', name: '李四' }],
    }))
    const r = await tool.execute({} as never, exec) as any
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ id: 'u1', name: '张三', email: 'z@x.com' })
  })
})

describe('outline_search all=true 自动翻页', () => {
  const hit = (id: string) => ({ id, title: id, url: '/d', snippet: '', collectionId: '', updatedAt: '' })
  it('逐页拉取并按 id 去重合并', async () => {
    const pages = [
      { total: 3, hits: [hit('a'), hit('b')] },
      { total: 3, hits: [hit('b'), hit('c')] },
      { total: 3, hits: [] },
    ]
    let call = 0
    const offsets: number[] = []
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (_q, _l, _c, _f, offset) => { offsets.push(offset ?? 0); return pages[call++] ?? { total: 3, hits: [] } },
    }), 10)
    const r = await tool.execute({ query: 'x', all: true }, exec) as any
    // 首抓 limit=100 只回了 2 条（短页）→ 兜底按实际页长 2 续抓 offset=2
    expect(offsets).toEqual([0, 2])
    expect(r.hits.map((h: any) => h.id)).toEqual(['a', 'b', 'c'])
    expect(r.total).toBe(3)
  })
  it('服务端无视 offset（整页重复）→ 不死循环', async () => {
    let call = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => { call += 1; return { total: 999, hits: [hit('a'), hit('b')] } },
    }), 10)
    const r = await tool.execute({ query: 'x', all: true }, exec) as any
    expect(call).toBe(2) // 第二页 fresh=0 即停
    expect(r.hits).toHaveLength(2)
  })
  it('默认单页不受影响', async () => {
    let call = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => { call += 1; return { total: 99, hits: [hit('a')] } },
    }), 10)
    await tool.execute({ query: 'x' }, exec)
    expect(call).toBe(1)
  })

  it('总数为 100 时抓满 4 页，顺序与串行一致且余下页面并发发出', async () => {
    const offsets: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (_q, _l, _c, _f, offset = 0) => {
        offsets.push(offset)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 3))
        inFlight -= 1
        return { total: 100, hits: Array.from({ length: 25 }, (_, i) => hit(`d${offset + i}`)) }
      },
    }), 10)
    const r = await tool.execute({ query: 'x', all: true }, exec) as any
    expect(offsets).toEqual([0, 25, 50, 75]) // 4 页都抓到、无越界 offset
    expect(maxInFlight).toBeGreaterThan(1) // 第 3、4 页并发发出
    expect(r.hits.map((h: any) => h.id)).toEqual(Array.from({ length: 100 }, (_, i) => `d${i}`)) // 顺序未被并发打乱
    expect(r.total).toBe(100)
  })

  it('实例支持 limit=100 时单请求抓满（1 次请求，不再逐页翻）', async () => {
    const limits: number[] = []
    let call = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (_q, limit) => {
        limits.push(limit)
        call += 1
        return { total: 100, hits: Array.from({ length: 100 }, (_, i) => hit(`d${i}`)) }
      },
    }), 10)
    const r = await tool.execute({ query: 'x', all: true }, exec) as any
    expect(call).toBe(1) // 关键：一次请求代替原来的 4 次串行翻页
    expect(limits).toEqual([100])
    expect(r.hits).toHaveLength(100)
  })
})

describe('outline_search 多词零命中回退', () => {
  const hit = (id: string) => ({ id, title: id, url: '/d', snippet: '', collectionId: '', updatedAt: '' })
  it('多词无结果 → 首词重试并标注 retriedWith', async () => {
    const seenQueries: string[] = []
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (q: string) => {
        seenQueries.push(q)
        return q === '部署' ? { total: 1, hits: [hit('a')] } : { total: 0, hits: [] }
      },
    }), 10)
    const r = await tool.execute({ query: '部署 规范 详细' }, exec) as any
    expect(seenQueries).toEqual(['部署 规范 详细', '部署'])
    expect(r.retriedWith).toBe('部署')
    expect(r.hits).toHaveLength(1)
  })
  it('单词零命中不重试', async () => {
    let call = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => { call += 1; return { total: 0, hits: [] } },
    }), 10)
    const r = await tool.execute({ query: '孤词' }, exec) as any
    expect(call).toBe(1)
    expect(r.retriedWith).toBeUndefined()
  })
  it('首词也无结果 → 保持原零结果（不误导）', async () => {
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => ({ total: 0, hits: [] }),
    }), 10)
    const r = await tool.execute({ query: '甲 乙' }, exec) as any
    expect(r.total).toBe(0)
    expect(r.retriedWith).toBeUndefined()
  })
})

describe('搜索结果渲染：翻页提示与回退标注', () => {
  const hit = (id: string) => ({ id, title: id, url: 'https://x/d', snippet: '', collectionId: '', updatedAt: '' })
  const tool = outlineSearchTool(() => fakeClient(), 10)
  it('有更多未显示 → 提示 offset/all 翻页', () => {
    const text = (tool as any).output.render({}, { total: 9, hits: [hit('a')] })[0].text
    expect(text).toContain('还有 8 篇未显示')
    expect(text).toContain('offset')
  })
  it('all 模式抓齐 → 显示已抓全部', () => {
    const text = (tool as any).output.render({ all: true }, { total: 2, hits: [hit('a'), hit('b')] })[0].text
    expect(text).toContain('已抓全部 2 篇')
    expect(text).not.toContain('未显示')
  })
  it('回退重试 → 首行标注实际生效词', () => {
    const text = (tool as any).output.render({}, { total: 1, hits: [hit('a')], retriedWith: '部署' })[0].text
    expect(text).toContain('已用 "部署" 重试命中')
  })
})

describe('rerankHits（本地重排）', () => {
  const hit = (id: string, title: string, snippet: string, updatedAt = '2026-09-01T00:00:00Z') =>
    ({ id, title, url: '/d', snippet, collectionId: '', updatedAt })
  it('标题命中排在仅摘要命中之前', () => {
    const r = rerankHits([hit('a', '无关标题', '部署在这里出现'), hit('b', '部署规范', '其他内容')], '部署')
    expect(r.map((h) => h.id)).toEqual(['b', 'a'])
  })
  it('同分保持服务端原序（稳定）', () => {
    const r = rerankHits([hit('a', '部署 X', ''), hit('b', '部署 Y', '')], '部署')
    expect(r.map((h) => h.id)).toEqual(['a', 'b'])
  })
  it('新近度加成：标题同级时新文档靠前', () => {
    const r = rerankHits([
      hit('old', '部署 旧', '', '2020-01-01T00:00:00Z'),
      hit('new', '部署 新', '', '2026-08-01T00:00:00Z'),
    ], '部署')
    expect(r.map((h) => h.id)).toEqual(['new', 'old'])
  })
  it('0/1 条命中或空查询原样返回', () => {
    expect(rerankHits([], 'x')).toEqual([])
    const one = [hit('a', 'T', '')]
    expect(rerankHits(one, 'x')).toBe(one)
    const two = [hit('a', 'T1', ''), hit('b', 'T2', '')]
    expect(rerankHits(two, '   ')).toBe(two)
  })
})

describe('synonymVariants（同义词候选）', () => {
  it('整词命中词表', () => {
    expect(synonymVariants('部署', { 部署: ['上线', '发布'] })).toEqual(['上线', '发布'])
  })
  it('多词查询逐词替换', () => {
    expect(synonymVariants('部署 规范', { 部署: ['上线'] })).toEqual(['上线 规范'])
  })
  it('去重 + 排除原词 + 上限 3', () => {
    const r = synonymVariants('甲', { 甲: ['乙', '乙', '甲', '丙', '丁', '戊'] })
    expect(r).toEqual(['乙', '丙', '丁'])
  })
  it('无词表命中返回空', () => {
    expect(synonymVariants('部署', {})).toEqual([])
    expect(synonymVariants('  ', { 部署: ['上线'] })).toEqual([])
  })
})

describe('outline_search 同义词回退阶梯', () => {
  const hit = (id: string) => ({ id, title: id, url: '/d', snippet: '', collectionId: '', updatedAt: '' })
  it('首词失败后按同义词变体重试并标注', async () => {
    const seen: string[] = []
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (q: string) => {
        seen.push(q)
        return q.startsWith('上线') ? { total: 1, hits: [hit('a')] } : { total: 0, hits: [] }
      },
    }), 10, undefined, () => ({ 部署: ['上线'] }))
    const r = await tool.execute({ query: '部署 规范' }, exec) as any
    expect(seen).toEqual(['部署 规范', '部署', '上线 规范'])
    expect(r.retriedWith).toBe('上线 规范')
  })
  it('未配置同义词：阶梯只剩首词', async () => {
    let call = 0
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => { call += 1; return { total: 0, hits: [] } },
    }), 10)
    await tool.execute({ query: '孤词' }, exec)
    expect(call).toBe(1)
  })
  it('结果按重排规则返回（标题命中优先）', async () => {
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async () => ({
        total: 2,
        hits: [
          { id: 'a', title: '无关', url: '/d', snippet: '部署出现在摘要', collectionId: '', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'b', title: '部署规范', url: '/d', snippet: '', collectionId: '', updatedAt: '2026-09-01T00:00:00Z' },
        ],
      }),
    }), 10)
    const r = await tool.execute({ query: '部署' }, exec) as any
    expect(r.hits.map((h: any) => h.id)).toEqual(['b', 'a'])
  })
})

describe('outline_search author 解析', () => {
  function searchWithUsers(users: any[], hits: any[]) {
    return outlineSearchTool(() => fakeClient({
      findUsers: async (q: string) => users.filter((u) => u.name.includes(q) || (u.email ?? '').includes(q)),
      searchDocuments: async () => ({ total: hits.length, hits }),
    }), 10)
  }
  it('author 精确匹配单人 → 服务端 userId 过滤', async () => {
    let seenUserId = ''
    const tool = outlineSearchTool(() => fakeClient({
      findUsers: async () => [{ id: 'u9', name: '张三' }],
      searchDocuments: async (_q, _l, _c, filters) => { seenUserId = filters?.userId ?? ''; return { total: 0, hits: [] } },
    }), 10)
    await tool.execute({ query: 'x', author: '张三' }, exec)
    expect(seenUserId).toBe('u9')
  })
  it('author 匹配多人 → 抛候选列表', async () => {
    const tool = outlineSearchTool(() => fakeClient({
      findUsers: async () => [{ id: 'u1', name: '张伟' }, { id: 'u2', name: '张强' }],
      searchDocuments: async () => ({ total: 0, hits: [] }),
    }), 10)
    await expect(tool.execute({ query: 'x', author: '张' }, exec)).rejects.toThrow(/匹配到多位作者/)
  })
  it('author 匹配 0 人 → 抛未找到', async () => {
    const tool = outlineSearchTool(() => fakeClient({
      findUsers: async () => [],
      searchDocuments: async () => ({ total: 0, hits: [] }),
    }), 10)
    await expect(tool.execute({ query: 'x', author: '王五' }, exec)).rejects.toThrow(/未找到名为/)
  })
  it('userId 直接传 → 不参与姓名解析', async () => {
    let seen = ''
    const tool = outlineSearchTool(() => fakeClient({
      searchDocuments: async (_q, _l, _c, filters) => { seen = filters?.userId ?? ''; return { total: 0, hits: [] } },
    }), 10)
    await tool.execute({ query: 'x', userId: 'direct-1' }, exec)
    expect(seen).toBe('direct-1')
  })
})

describe('search result 渲染作者名', () => {
  it('命中行附带（作者：xxx）', async () => {
    const tool = outlineSearchTool(() => fakeClient(), 10)
    const value = {
      total: 1,
      hits: [{ id: 'd1', title: 'T', url: 'https://x/d', snippet: '', collectionId: '', updatedAt: '', authorName: '张三' }],
    }
    const text = (tool as any).output.render({}, value)[0].text
    expect(text).toContain('（作者：张三）')
  })
})

describe('sanitizeFileName', () => {
  it('替换文件系统非法字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })
  it('空标题回退 untitled', () => {
    expect(sanitizeFileName('   ')).toBe('untitled')
  })
})

describe('buildSaveFileName', () => {
  it('日期前缀 + 合法化标题 + .md', () => {
    expect(buildSaveFileName('部署规范', new Date(2026, 8, 4))).toBe('2026-09-04-部署规范.md')
  })
})

describe('dedupeFileName', () => {
  it('无冲突返回原名', async () => {
    expect(await dedupeFileName('/d', 'a.md', async () => false)).toBe('a.md')
  })
  it('冲突时追加序号', async () => {
    const exists = async (p: string) => p === 'a.md' || p === 'a-2.md'
    expect(await dedupeFileName('.', 'a.md', exists)).toBe('a-3.md')
  })
})

describe('documentToMarkdown', () => {
  it('包含标题、来源链接与正文', () => {
    const md = documentToMarkdown({ id: 'd1', title: 'T', url: 'https://x/doc/d1', text: '正文', updatedAt: '' })
    expect(md).toContain('# T')
    expect(md).toContain('https://x/doc/d1')
    expect(md).toContain('正文')
  })
})

describe('mergeDocumentsToMarkdown', () => {
  it('生成目录 + 各篇全文', () => {
    const md = mergeDocumentsToMarkdown(
      [
        { id: 'd1', title: 'A', url: 'https://x/a', text: '正文A', updatedAt: '' },
        { id: 'd2', title: 'B', url: 'https://x/b', text: '正文B', updatedAt: '' },
      ],
      '合并导出',
    )
    expect(md).toContain('# 合并导出')
    expect(md).toContain('1. [A](https://x/a)')
    expect(md).toContain('# A')
    expect(md).toContain('正文A')
    expect(md).toContain('# B')
    expect(md).toContain('正文B')
  })
})

describe('outline_save_local（批量 ids）', () => {
  it('未配置保存目录时拒绝', async () => {
    const tool = outlineSaveLocalTool(() => '', () => fakeClient())
    await expect(tool.execute({ ids: 'd1' }, exec)).rejects.toThrow('未配置')
  })
  it('ids 为空或全空白时拒绝', async () => {
    const tool = outlineSaveLocalTool(() => 'D:\\x', () => fakeClient())
    await expect(tool.execute({ ids: ' , , ' }, exec)).rejects.toThrow('至少一个文档 id')
  })
  it('单篇：写盘并返回绝对路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-save-'))
    try {
      const tool = outlineSaveLocalTool(() => dir, () => fakeClient({
        getDocument: async () => ({ id: 'd1', title: '部署规范', url: 'https://x/doc/d1', text: '步骤一', updatedAt: '' }),
      }))
      const r = await tool.execute({ ids: 'd1' }, exec) as any
      expect(r.documents).toBe(1)
      expect(r.path).toContain('部署规范.md')
      expect(r.bytes).toBeGreaterThan(0)
      const content = readFileSync(r.path, 'utf8')
      expect(content).toContain('# 部署规范')
      expect(content).toContain('步骤一')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('多篇：合并为带目录的一个 md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-save-'))
    try {
      const tool = outlineSaveLocalTool(() => dir, () => fakeClient({
        getDocument: async (id: string) => ({ id, title: `D-${id}`, url: `https://x/${id}`, text: `内容-${id}`, updatedAt: '' }),
      }))
      const r = await tool.execute({ ids: 'd1, d2 , d1' }, exec) as any // 去重：d1 两次
      expect(r.documents).toBe(2)
      const content = readFileSync(r.path, 'utf8')
      expect(content).toContain('D-d1等2篇')
      expect(content).toContain('内容-d1')
      expect(content).toContain('内容-d2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('同名文件冲突自动加序号，不覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-save-'))
    try {
      const tool = outlineSaveLocalTool(() => dir, () => fakeClient({
        getDocument: async () => ({ id: 'd1', title: 'T', url: '/d', text: '内容', updatedAt: '' }),
      }))
      const first = await tool.execute({ ids: 'd1' }, exec) as any
      const second = await tool.execute({ ids: 'd1' }, exec) as any
      expect(second.path).not.toBe(first.path)
      expect(second.path).toMatch(/-2\.md$/)
      expect(readFileSync(first.path, 'utf8')).toContain('内容')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('超过 SAVE_MAX_DOCS 上限拒绝', async () => {
    const tool = outlineSaveLocalTool(() => 'D:\\x', () => fakeClient())
    const many = Array.from({ length: 51 }, (_, i) => `d${i}`).join(',')
    await expect(tool.execute({ ids: many }, exec)).rejects.toThrow('一次最多保存')
  })
})
