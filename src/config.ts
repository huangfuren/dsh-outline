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
 * dsh >= 0.1.7 的宿主从插件声明的 Config schema 自动生成「设置 → 插件 → 插件配置」表单，
 * 但只收录标记了 volatile 的字段（见 settings 的 volatileForm）。
 * dsh 0.1.5 / 0.1.6 的 schemastery 没有 .volatile() 方法，此处原样返回，行为完全不变。
 */
function volatile<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => unknown } | null
  if (candidate !== null && candidate !== undefined && typeof candidate.volatile === 'function') {
    return candidate.volatile() as T
  }
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
