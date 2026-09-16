import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as OutlineAuto from '../src/index.js'

/**
 * 回归护栏：设置卡片依赖宿主的 SettingsProvider.installSection。
 * 旧代码调用宿主已移除的自由函数 installSettingsSection，运行时静默降级，
 * 「设置 → 插件 → 插件配置」卡片凭空消失而全部测试仍绿。
 * 此处用真实 @deepseek-ai/dsh-settings 启动 provider，正面断言命名空间已注册、
 * 用户层覆盖 config、且覆盖结果立即驱动 API 调用。
 */

/** 内存 provider：只实现 load/persist 两个抽象原语（宿主 settings-file 同形）。 */
class MemoryProvider extends SettingsProvider {
  private doc: Record<string, unknown>
  constructor(ctx: Context, options: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
  }
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

type RegisteredTool = { name: string; execute: (args?: unknown, exec?: unknown) => Promise<unknown> }

const tools: RegisteredTool[] = []

async function boot(config: Record<string, unknown>): Promise<{ ctx: Context; provider: SettingsProvider }> {
  tools.length = 0
  const ctx = new Context()
  ctx.provide('tools', { register: (tool: unknown) => tools.push(tool as RegisteredTool) } as never)
  await ctx.plugin(MemoryProvider, { doc: {} })
  const provider = ctx.get('settings')
  await ctx.plugin(OutlineAuto as never, config)
  return { ctx, provider }
}

const savedEnv = { baseUrl: process.env.OUTLINE_BASE_URL, token: process.env.OUTLINE_API_TOKEN }

beforeAll(() => {
  delete process.env.OUTLINE_BASE_URL
  delete process.env.OUTLINE_API_TOKEN
})

afterAll(() => {
  if (savedEnv.baseUrl !== undefined) process.env.OUTLINE_BASE_URL = savedEnv.baseUrl
  if (savedEnv.token !== undefined) process.env.OUTLINE_API_TOKEN = savedEnv.token
})

describe('settings 段落注册', () => {
  it('在宿主 settings 服务上注册 outline-auto 命名空间（卡片存在的前提）', async () => {
    const { provider } = await boot({ baseUrl: 'https://cfg.example', apiToken: 'cfg-token' })
    const view = provider.describe().find((entry) => entry.ns === 'outline-auto')
    expect(view, 'settings.describe() 无 outline-auto：插件未走宿主 installSection').toBeDefined()
    expect(provider.get('outline-auto')).toMatchObject({ baseUrl: 'https://cfg.example' })
    expect(tools.map((t) => t.name)).toContain('outline_count')
  })

  it('用户层覆盖 config 后立即生效于 API 调用', async () => {
    const original = globalThis.fetch
    try {
      let seen = ''
      globalThis.fetch = ((url: unknown) => {
        seen = String(url)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ data: [], pagination: { total: 7 } }),
        })
      }) as unknown as typeof fetch

      const { provider } = await boot({ baseUrl: 'https://cfg.example', apiToken: 'cfg-token' })
      await provider.update('outline-auto', { baseUrl: 'https://user.example', apiToken: 'user-token' })

      const count = tools.find((t) => t.name === 'outline_count')
      expect(count).toBeDefined()
      expect(await count!.execute({}, {})).toEqual({ total: 7 })
      expect(seen).toBe('https://user.example/api/documents.list')
    } finally {
      globalThis.fetch = original
    }
  })

  it('未配置时给出指向设置卡片的报错', async () => {
    await boot({})
    const count = tools.find((t) => t.name === 'outline_count')
    await expect(count!.execute({}, {})).rejects.toThrow(/设置 → 插件 → 插件配置/)
  })
})