import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Outline 实例根地址，如 https://outline.example.com（不含尾斜杠） */
  baseUrl?: string
  /** Outline API token（设置 → API 密钥）；环境变量 OUTLINE_API_TOKEN 优先 */
  apiToken?: string
  /** HTTP 请求超时（毫秒） */
  timeoutMs: number
  /** outline_search 默认返回条数 */
  searchLimit: number
  /** 可写目录路径（逗号分隔）：仅这些目录及其全部子级允许创建/更新/删除文档；留空 = 全库只读（默认） */
  writablePaths?: string
  /** 读取缓存有效期（毫秒），默认 60000，范围 1000~300000 */
  cacheTtlMs?: number
  /** 本地保存目录：把搜索结果/文档存为 Markdown 文件的位置；留空 = $DSH_HOME/outline-auto-saves */
  localSaveDir?: string
  /** 同义词/别名表（原词 → 替换词列表）：搜索零命中时自动用替换词重试。例：{ "部署": ["上线", "发布"] } */
  synonyms?: Record<string, string[]>
}

/**
 * 兼容性 shim：把字段标记为 volatile。
 *
 * 宿主从插件声明的 Config schema 自动生成设置表单，但只收录标记了 volatile 的字段
 * （见 `packages/settings/settings/src/schema.ts` 的 `volatileForm` / `isVolatilePath`，
 * 两者都读 `schema.meta.volatile`）。两条路径：
 *
 * - schemastery 带 `.volatile()`（dsh 0.2.x 随附的版本）→ 调它，语义交给上游；
 * - 不带的（dsh 0.1.7 随附 3.18.1，实测 `typeof Schema.string().volatile === 'undefined'`）
 *   → 直接写 `meta.volatile`，落点与 `.volatile()` 完全相同。
 *
 * ⚠️ 不要用 `.set('meta', …)`：3.18.1 上会以
 * `Cannot set properties of undefined (setting 'meta')` 失败（字段未先建 meta 时）。
 * ⚠️ 也不要在拿不到标记时静默跳过 —— 那会让整条命名空间不被宿主投影，
 * 卡片读到 `status: 'unavailable'` 后渲染成空白。
 *
 * dsh 0.1.5 / 0.1.6 完全不读这个标记，写上去无副作用。
 */
function volatile<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => unknown; meta?: Record<string, unknown> } | null
  if (candidate === null || candidate === undefined) return schema
  if (typeof candidate.volatile === 'function') return candidate.volatile() as T
  candidate.meta = { ...(candidate.meta ?? {}), volatile: true }
  return schema
}

/**
 * 读取一个可能被宿主包装的配置值。
 *
 * dsh 0.1.7+ 对 volatile 字段递给插件的是 `Volatile<T>`（取值需 .get()）；旧版本与
 * 非 volatile 字段是普通值。两种形态都能取到原始值，避免升级后 `config.x.trim()` 拿到
 * 包装对象而崩溃。
 */
export function readValue<T>(value: T): T {
  const candidate = value as unknown as { get?: () => unknown } | null
  if (candidate !== null && candidate !== undefined && typeof candidate === 'object'
    && typeof (candidate as { get?: () => unknown }).get === 'function') {
    return (candidate as { get: () => unknown }).get() as T
  }
  return value
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: volatile(Schema.string().description('Outline 实例根地址，如 https://outline.example.com')),
  apiToken: volatile(Schema.string().description('Outline API token；环境变量 OUTLINE_API_TOKEN 优先')),
  timeoutMs: volatile(Schema.number().min(1000).default(15000).description('HTTP 请求超时（毫秒）')),
  searchLimit: volatile(Schema.number().min(1).max(25).default(10).description('outline_search 默认返回条数')),
  writablePaths: volatile(Schema.string().default('').description('可写目录路径（逗号分隔），如 集合A,集合B/目录1；留空 = 全库只读（默认）')),
  cacheTtlMs: volatile(Schema.number().min(1000).max(300000).default(60000).description('读取缓存有效期（毫秒），默认 60000')),
  localSaveDir: volatile(Schema.string().default('').description('本地保存目录：搜索结果/文档可存为 Markdown 文件的位置；留空 = $DSH_HOME/outline-auto-saves')),
  synonyms: volatile(Schema.dict(Schema.array(Schema.string())).default({}).description('同义词/别名表（原词 → 替换词列表）：搜索零命中时自动用替换词重试，如 { "部署": ["上线", "发布"] }')),
})

export type { Context }
