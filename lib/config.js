import Schema from '@deepseek-ai/schemastery';
/**
 * 兼容性 shim：把字段标记为 volatile。
 *
 * dsh >= 0.1.7 的宿主从插件声明的 Config schema 自动生成「设置 → 插件 → 插件配置」表单，
 * 但只收录标记了 volatile 的字段（见 settings 的 volatileForm）。
 * dsh 0.1.5 / 0.1.6 的 schemastery 没有 .volatile() 方法，此处原样返回，行为完全不变。
 */
function volatile(schema) {
    const candidate = schema;
    if (candidate !== null && candidate !== undefined && typeof candidate.volatile === 'function') {
        return candidate.volatile();
    }
    return schema;
}
/**
 * 读取一个可能被宿主包装的配置值。
 *
 * dsh 0.1.7+ 对 volatile 字段递给插件的是 `Volatile<T>`（取值需 .get()）；旧版本与
 * 非 volatile 字段是普通值。两种形态都能取到原始值，避免升级后 `config.x.trim()` 拿到
 * 包装对象而崩溃。
 */
export function readValue(value) {
    const candidate = value;
    if (candidate !== null && candidate !== undefined && typeof candidate === 'object'
        && typeof candidate.get === 'function') {
        return candidate.get();
    }
    return value;
}
export const Config = Schema.object({
    baseUrl: volatile(Schema.string().description('Outline 实例根地址，如 https://outline.example.com')),
    apiToken: volatile(Schema.string().description('Outline API token；环境变量 OUTLINE_API_TOKEN 优先')),
    timeoutMs: volatile(Schema.number().min(1000).default(15000).description('HTTP 请求超时（毫秒）')),
    searchLimit: volatile(Schema.number().min(1).max(25).default(10).description('outline_search 默认返回条数')),
    writablePaths: volatile(Schema.string().default('').description('可写目录路径（逗号分隔），如 集合A,集合B/目录1；留空 = 全库只读（默认）')),
    cacheTtlMs: volatile(Schema.number().min(1000).max(300000).default(60000).description('读取缓存有效期（毫秒），默认 60000')),
    localSaveDir: volatile(Schema.string().default('').description('本地保存目录：搜索结果/文档可存为 Markdown 文件的位置；留空 = $DSH_HOME/outline-auto-saves')),
    synonyms: volatile(Schema.dict(Schema.array(Schema.string())).default({}).description('同义词/别名表（原词 → 替换词列表）：搜索零命中时自动用替换词重试，如 { "部署": ["上线", "发布"] }')),
});
