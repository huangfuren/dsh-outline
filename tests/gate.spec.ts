/**
 * 审批闸专项测试（回归：闸是写路径唯一的人工闸门，却长期零测试覆盖）。
 *
 * 测试按宿主 dsh-tools 0.2.0-rc.2 的真实流水线还原：
 *   prepareExecution → waterfall("tools/pre-execute", exec, () => ({kind:'allow'}))
 *                     → 若 ask 则走 serviceAsk（批准得 allowed-once → allow）
 *                     → 仅当决策为 allow 时才查询 ctx.tools.guard() 的单调守卫
 * 因此这里不是"调用一个函数看看返回值"，而是把整条策略链跑一遍。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { apply } from '../src/index.js'

// 复用仓库自带的 mock Outline 实例（与 scripts/smoke.mjs 同源）
const { createMockOutlineServer } = await import('../scripts/mock-outline-server.mjs' as string)

delete process.env.OUTLINE_BASE_URL
delete process.env.OUTLINE_API_TOKEN

let server: { listen: Function; address: Function; close: Function }
let baseUrl = ''

beforeAll(async () => {
  server = createMockOutlineServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => { server.close() })

interface Harness {
  listeners: Map<string, Array<(exec: never, next: () => unknown) => unknown>>
  guards: Array<(exec: { name?: string }) => string | undefined>
  registered: string[]
  approvalOutcome: string
}

function makeHarness (options: { writablePaths: string; omitOn?: boolean; shortCircuit?: boolean }): Harness {
  const listeners = new Map<string, Array<(exec: never, next: () => unknown) => unknown>>()
  const guards: Array<(exec: { name?: string }) => string | undefined> = []
  const registered: string[] = []
  const state: Harness = { listeners, guards, registered, approvalOutcome: 'allowed-once' }
  const on = (name: string, listener: (exec: never, next: () => unknown) => unknown) => {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name)!.push(listener)
    return () => {}
  }
  const ctx: Record<string, unknown> = {
    tools: {
      register: (tool: { name: string }) => { registered.push(tool.name) },
      guard: (g: (exec: { name?: string }) => string | undefined) => { guards.push(g); return () => {} },
    },
    inject: (names: string[], callback: Function) => {
      if (names.includes('settings')) callback({ settings: { installSection: () => {} } })
      return () => {}
    },
    on,
    get: (name: string) => name === 'approval'
      ? { request: async () => state.approvalOutcome }
      : undefined,
  }
  if (options.omitOn === true) delete ctx.on
  // 抢先注册"短路"监听器：返回 allow 且不调用 next() → 后续监听器（本插件的闸）不会被执行
  if (options.shortCircuit === true) on('tools/pre-execute', async () => ({ kind: 'allow' }))
  apply(ctx as never, { baseUrl, apiToken: 'test-token', timeoutMs: 5000, searchLimit: 5, writablePaths: options.writablePaths })
  return state
}

/** 还原宿主策略链：waterfall → (ask → serviceAsk) → 仅 allow 时查 guard。 */
async function runPipeline (h: Harness, name: string, args: Record<string, unknown>) {
  const exec = { name, arguments: args, callId: 'call-1', agent: { session: {} }, signal: new AbortController().signal }
  const chain = [...(h.listeners.get('tools/pre-execute') ?? [])]
  const inner = () => Promise.resolve({ kind: 'allow' })
  const next = () => (chain.shift() ?? inner)(exec as never, next)
  const decision = (await next()) as { kind: string; reason?: string }

  const effective = decision.kind === 'ask'
    ? { kind: h.approvalOutcome === 'allowed-once' ? 'allow' : 'deny' }
    : decision

  let floorReason: string | undefined
  if (effective.kind === 'allow') {
    for (const guard of h.guards) {
      const reason = guard(exec)
      if (reason !== undefined) { floorReason = reason; break }
    }
  }
  return { decision, effective, floorReason, exec }
}

describe('审批闸：决策矩阵（writablePaths = 测试集合）', () => {
  it('读工具不被拦截', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    expect((await runPipeline(h, 'outline_search', { query: '部署' })).decision.kind).toBe('allow')
    expect((await runPipeline(h, 'outline_get_document', { id: 'doc-1' })).decision.kind).toBe('allow')
  })

  it('集合内创建 → ask，且闸标记使单调地板放行', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const r = await runPipeline(h, 'outline_create', { collectionId: 'col-1', title: 'T', text: 'x' })
    expect(r.decision.kind).toBe('ask')
    expect(r.decision.reason).toContain('创建 Outline 文档')
    expect(r.floorReason).toBeUndefined()
  })

  it('白名单外集合创建 → deny（deny 分支不经过地板，宿主只在 allow 时查 guard）', async () => {
    const h = makeHarness({ writablePaths: '别的目录' })
    const r = await runPipeline(h, 'outline_create', { collectionId: 'col-1', title: 'T', text: 'x' })
    expect(r.decision.kind).toBe('deny')
    expect(r.decision.reason).toContain('不在可写目录内')
    expect(r.floorReason).toBeUndefined()
  })

  it('空白名单（只读模式）→ 三个写工具全 deny', async () => {
    const h = makeHarness({ writablePaths: '' })
    for (const [name, args] of [
      ['outline_create', { collectionId: 'col-1', title: 'T', text: 'x' }],
      ['outline_update_document', { id: 'doc-1', title: 'T' }],
      ['outline_delete', { id: 'doc-1' }],
    ] as const) {
      const r = await runPipeline(h, name, args as Record<string, unknown>)
      expect(r.decision.kind).toBe('deny')
      expect(r.decision.reason).toContain('只读模式')
    }
  })

  it('update 缺 title/text/publish → deny', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const r = await runPipeline(h, 'outline_update_document', { id: 'doc-1' })
    expect(r.decision.kind).toBe('deny')
    expect(r.decision.reason).toContain('至少需要')
  })

  it('只改 publish → ask（不是 deny）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const r = await runPipeline(h, 'outline_update_document', { id: 'doc-1', publish: false })
    expect(r.decision.kind).toBe('ask')
    expect(r.decision.reason).toContain('转为草稿')
  })

  it('append 追加 → 审批文案标"追加正文"（不写"整体替换"）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const r = await runPipeline(h, 'outline_update_document', { id: 'doc-1', text: '追加段', append: true })
    expect(r.decision.kind).toBe('ask')
    expect(r.decision.reason).toContain('追加正文')
    expect(r.decision.reason).not.toContain('整体替换')
  })

  it('删除在白名单内 → ask（第 1 次确认）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const r = await runPipeline(h, 'outline_delete', { id: 'doc-1' })
    expect(r.decision.kind).toBe('ask')
    expect(r.decision.reason).toContain('第 1 次确认')
  })
})

describe('审批闸：单调地板（短路免疫）', () => {
  it('他方监听器抢先 allow 并短路 → 闸不执行，但地板仍然拒绝写调用', async () => {
    const h = makeHarness({ writablePaths: '测试集合', shortCircuit: true })
    const write = await runPipeline(h, 'outline_update_document', { id: 'doc-1', title: 'T' })
    expect(write.decision.kind).toBe('allow')
    expect(write.floorReason).toContain('未经 dsh-outline 的审批闸')

    const read = await runPipeline(h, 'outline_search', { query: 'x' })
    expect(read.floorReason).toBeUndefined()
  })

  it('闸未安装（无 ctx.on）→ 全部写调用被地板拒绝（fail-closed），读工具不受影响', async () => {
    const h = makeHarness({ writablePaths: '测试集合', omitOn: true })
    expect(h.registered).toContain('outline_create')
    for (const [name, args] of [
      ['outline_create', { collectionId: 'col-1', title: 'T', text: 'x' }],
      ['outline_update_document', { id: 'doc-1', title: 'T' }],
      ['outline_delete', { id: 'doc-1' }],
    ] as const) {
      const r = await runPipeline(h, name, args as Record<string, unknown>)
      expect(r.effective.kind).toBe('allow')
      expect(r.floorReason).toContain('未经 dsh-outline 的审批闸')
    }
    expect((await runPipeline(h, 'outline_count', {})).floorReason).toBeUndefined()
  })

  it('用户否决审批 → 决策为 deny，地板不参与（不会把 deny 变 allow）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    h.approvalOutcome = 'rejected'
    const r = await runPipeline(h, 'outline_create', { collectionId: 'col-1', title: 'T', text: 'x' })
    expect(r.decision.kind).toBe('ask')
    expect(r.effective.kind).toBe('deny')
  })
})

describe('审批闸：读→改→写截断护栏', () => {
  /** 直接打 mock 的 documents.create，造一篇超过 20000 字符的长文。 */
  async function seedLongDoc (length: number): Promise<string> {
    const response = await fetch(`${baseUrl}/api/documents.create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ collectionId: 'col-1', title: '长文截断用例', text: 'A'.repeat(length) }),
    })
    const json = await response.json() as { data: { id: string } }
    return json.data.id
  }

  it('把截断读出的正文写回 → 审批文案带确切字符数与补救办法', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const id = await seedLongDoc(25000)
    const r = await runPipeline(h, 'outline_update_document', { id, text: 'A'.repeat(20000) })
    expect(r.decision.kind).toBe('ask')
    expect(r.decision.reason).toContain('疑似把读取时被截断的正文写回')
    expect(r.decision.reason).toContain('原文 25000 字符 → 写回 20000 字符')
    expect(r.decision.reason).toContain('丢失 5000 字符')
    expect(r.decision.reason).toContain('append: true')
  })

  it('append: true 追加 → 不触发截断告警（追加不覆盖原文）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const id = await seedLongDoc(25000)
    const r = await runPipeline(h, 'outline_update_document', { id, text: 'A'.repeat(20000), append: true })
    expect(r.decision.kind).toBe('ask')
    expect(String(r.decision.reason)).not.toContain('疑似把读取时被截断的正文写回')
  })

  it('正常短写不改动长文时不会误报（新正文比原文长）', async () => {
    const h = makeHarness({ writablePaths: '测试集合' })
    const id = await seedLongDoc(50)
    const r = await runPipeline(h, 'outline_update_document', { id, text: 'x'.repeat(200) })
    expect(String(r.decision.reason)).not.toContain('疑似把读取时被截断的正文写回')
  })
})
