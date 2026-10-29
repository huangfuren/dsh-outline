/**
 * 按并发上限批量执行异步任务，返回值保持入参顺序（任一任务抛错则整体抛出，由调用方决定降级）。
 * 用于把「N 次串行往返」压成「1 次 + 并发」：结果与串行完全一致，只是等待时间被重叠掉。
 */
export declare function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/** Outline 服务端分页硬上限：limit > 100 会被以 400 "Pagination limit is too large" 拒绝。 */
export declare const OUTLINE_MAX_PAGE_SIZE = 100;
export interface OutlineSearchHit {
    id: string;
    title: string;
    url: string;
    snippet: string;
    collectionId: string;
    updatedAt: string;
    parentDocumentId?: string;
    /** 作者显示名（取自搜索响应的 createdBy.name；缺省时回退 users.list 映射）。 */
    authorName?: string;
}
/**
 * 时间过滤的实际生效位置。
 * - `server`：实例支持 `filters`（Outline 1.12+），过滤在服务端完成，total 与 hits 一致。
 * - `client`：实例不支持 `filters`，改为对已取回的这一页按 updatedAt 本地筛选；
 *   `total` 仍是服务端未过滤的总数，hits 可能少于 limit。
 */
export type TimeFilterMode = 'server' | 'client';
/** 搜索结果：命中列表 + 该关键词在知识库中的匹配总数（pagination.total）。 */
export interface OutlineSearchResult {
    total: number;
    hits: OutlineSearchHit[];
    /** 多词查询零命中时自动用首词重试成功后，记录实际生效的首词。 */
    retriedWith?: string;
    /** 仅在请求带 `updatedAfter` 时出现，说明时间过滤是服务端做的还是本地补的。 */
    timeFilterMode?: TimeFilterMode;
}
export interface OutlineDocument {
    id: string;
    title: string;
    url: string;
    text: string;
    updatedAt: string;
    collectionId?: string;
    parentDocumentId?: string;
}
/** Outline 集合（collections.list 条目）。documentCount 部分实例可能不返回。 */
export interface OutlineCollection {
    id: string;
    name: string;
    permission: string;
    documentCount?: number;
}
/**
 * 写入类工具（create / update）返回的文档信息。
 * `published` 为可选：实例未在响应里返回发布状态时**不臆造**（旧实现盲填 `true`，
 * 会把草稿报成已发布）。缺省时由工具的 render 明确说明"服务端未返回发布状态"。
 */
export interface OutlineCreateResult {
    id: string;
    url: string;
    title: string;
    published?: boolean;
}
/** Outline 用户（users.list 条目）。 */
export interface OutlineUser {
    id: string;
    name: string;
    email?: string;
}
export interface OutlineClientOptions {
    baseUrl: string;
    apiToken: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
    fetchImpl?: typeof fetch;
}
export declare class OutlineClient {
    private readonly fetchImpl;
    private readonly timeoutMs;
    private readonly cacheTtlMs;
    private readonly baseUrl;
    private readonly apiToken;
    /** getDocument 的短期缓存（key = 文档 id），避免会话内重复读取同一文档反复请求 API。 */
    private readonly docCache;
    private static readonly DEFAULT_CACHE_TTL_MS;
    /** 文档缓存条数上限：超限时按插入顺序淘汰最旧条目，防止长时间运行内存膨胀。 */
    private static readonly DOC_CACHE_MAX_ENTRIES;
    /** 429 限流自动重试次数（指数退避，每次最多退避 5 秒）。 */
    private static readonly MAX_RETRIES;
    /** listCollections 的短期缓存，供审批钩子解析集合名。 */
    private collectionsCache;
    /** listUsers 的短期缓存（id→name 映射 + 姓名解析复用）。 */
    private usersCache;
    /** searchDocuments 结果的短期缓存（key = 归一化查询参数），同 query 连续提问不重复打 API。 */
    private readonly searchCache;
    /**
     * 实例是否支持 `filters` 数组式过滤（Outline 1.12 起引入；此前版本会把该字段
     * 当未知键静默丢弃且不报错）。`undefined` = 尚未探测。
     */
    private filterSupport;
    private static readonly SEARCH_CACHE_MAX_ENTRIES;
    /** Outline 服务端分页上限（limit > 100 直接返回 400 "Pagination limit is too large"）。 */
    private static readonly MAX_PAGE_SIZE;
    /** 单次工具调用内同时在飞的请求数上限：压住并发以免瞬时打爆上游（触发 429 反而更慢）。 */
    private static readonly MAX_CONCURRENCY;
    constructor(options: OutlineClientOptions);
    /** 安全校验：拒绝公网明文 http（避免 Token 明文传输），允许 https 以及本地/内网私有地址。 */
    private assertAllowedUrl;
    /** 去掉 Outline 片段/标题里的 HTML 标签（如 <b>），避免原样渲染进聊天。 */
    private static stripHtml;
    /** 把 Outline API 返回的相对文档路径（如 /doc/xxx）解析为可点击的绝对地址。 */
    private absolutize;
    /** 请求并返回完整 JSON 响应体（data + pagination 等元数据）。 */
    private requestJson;
    private request;
    /**
     * 通用分页拉取：先取第一页拿到 total，再按需并发补齐后续页（并发上限 MAX_CONCURRENCY）。
     * 结果按 offset 顺序拼接 —— 与逐页串行拉取逐条等价（同集合、同顺序、不漏项），
     * 但把 N 次串行往返压成「1 次 + 并发」，大集合/多用户实例下省掉 N-1 个 RTT。
     * 页偏移按上一页实际返回条数推进：服务端若把 limit 压得更小也不会漏页。
     */
    private fetchAllPages;
    /**
     * 探测实例是否支持 `filters` 式查询（Outline 1.12 起引入）。
     *
     * 判据：带一个「未来时间点」的 updatedAt 过滤做一次最小查询。
     * - 支持：服务端真的按条件过滤 → `pagination.total` = 0
     * - 不支持：`filters` 被当未知键静默丢弃（Outline 的 schema 没有 `.strict()`，不报错）→ total = 库里真实总数
     *
     * 只在真正需要时间过滤时调用，结果缓存在实例上（同一实例的运行期版本不会中途变化）。
     * **不能吞掉所有异常**：只有「服务端明确拒绝该参数」（400/422）才算「不支持」；
     * 网络故障、鉴权失败必须向上抛，否则一次偶发失败会被固化成永久的能力误判。
     */
    private supportsFilters;
    searchDocuments(query: string, limit: number, collectionId?: string, filters?: {
        userId?: string;
        updatedAfter?: string;
    }, offset?: number): Promise<OutlineSearchResult>;
    /** 写操作后失效搜索缓存（结果可能随增删改变化）。 */
    private invalidateCaches;
    /** 统计 Outline 知识库文档总数（documents.list 分页 total；不含已删除/回收站文档）。 */
    countDocuments(filters?: Record<string, unknown>): Promise<number>;
    /** 列出当前 token 可见的集合（短期缓存）。注：实例要求 collections.list 带查询串。 */
    listCollections(force?: boolean): Promise<OutlineCollection[]>;
    /** 列出当前 token 可见的用户（短期缓存）。用于"某人写的文档"姓名→id 解析。 */
    listUsers(force?: boolean): Promise<OutlineUser[]>;
    /**
     * 按姓名或邮箱找用户：先精确匹配（唯一才算），再子串包含匹配（不区分大小写）。
     * 返回所有匹配（0 个 = 未找到；>1 个 = 有歧义，由调用方列出候选）。
     */
    findUsers(query: string): Promise<OutlineUser[]>;
    /** id→姓名映射（基于 users.list 缓存）。users.list 不可用时返回空映射（fail-open）。 */
    private userNameMap;
    /** 在指定集合创建文档（默认发布；可指定父文档实现嵌套）。 */
    createDocument(input: {
        collectionId: string;
        title: string;
        text: string;
        publish?: boolean;
        parentDocumentId?: string;
    }): Promise<OutlineCreateResult>;
    /**
     * 更新已有文档（至少提供 title / text / publish 之一）。
     * - `append: true` → 用 Outline 原生的追加语义，把 text 接到正文末尾而非整体覆盖（长文改动的安全路径）。
     * - `publish` → 显式切换发布状态（true 发布 / false 转草稿）；不传则该状态不变。
     * 未声明的字段一律不透传：payload 是白名单构造的，不做 `...input` 透传，
     * 避免调用方误传 Outline 参数（如 collectionId 移动）时出现"返回成功但语义被丢弃"。
     */
    updateDocument(id: string, input: {
        title?: string;
        text?: string;
        append?: boolean;
        publish?: boolean;
    }): Promise<OutlineCreateResult>;
    /**
     * 删除文档（调用方必须已通过双重审批）。
     *
     * 结果判定刻意"宁严勿宽"：只有服务端**明确**给出成功标记才算成功。
     * 原实现用 `json.success !== false`，在顶层没有 `success` 字段时（例如响应形如
     * `{data:{success:true}}` 或任何缺字段的 200 响应）会兜底成 `true` —— 那是 fail-open：
     * 删除没生效却向用户报"已删除"。对一个不可恢复的操作，谎报成功比报失败危险得多。
     * 兼容三种已知响应形态：顶层 `{success:true}`（本实例）、`{data:{success:true}}`（mock/部分版本）、`{ok:true}`。
     */
    deleteDocument(id: string): Promise<{
        success: boolean;
    }>;
    /**
     * 取文档信息。
     * @param force 跳过 60s 缓存（仍会把新值写回缓存）。写入守卫解析路径时传 true ——
     *   白名单是**按名称前缀**匹配的，而集合/目录在带外被改名后，缓存最多会让匹配结果滞后 60s，
     *   等于用一个可能过期的名字去决定"这个位置可不可写"。读场景继续用缓存。
     */
    getDocument(id: string, force?: boolean): Promise<OutlineDocument>;
    /** 列出某父文档下的直接子文档（用于路径定位；本地匹配名称，避免搜索分词歧义）。 */
    listChildDocuments(parentDocumentId: string, pageSize?: number): Promise<OutlineSearchHit[]>;
    /**
     * 解析一个文档的完整路径：返回 [集合名, 顶级目录, …, 文档名]（自顶向下）。
     * @param force 跳过文档缓存（写入守卫用 true，避免用 60s 前的旧名字做白名单匹配）。
     */
    resolveDocumentPath(docId: string, force?: boolean): Promise<string[]>;
    /**
     * 拉取一篇文档的摘要原文（前 N 字符的纯文本正文）。
     * 复用 getDocument 的 60s 缓存，避免 context_search 重复打 API。
     * 超长文本截断后追加 …标记。
     */
    getDocumentExcerpt(id: string, maxChars?: number): Promise<{
        id: string;
        title: string;
        url: string;
        excerpt: string;
        updatedAt: string;
    }>;
    /**
     * 搜索并批量拉取命中文档的摘要原文（供 outline_context_search 工具使用）。
     * 并发拉取（上限 MAX_CONCURRENCY），复用 getDocument 缓存。
     * @returns 搜索结果 + 每条命中附带 excerpt 字段（文档正文前 N 字符）
     */
    searchWithExcerpts(query: string, limit: number, collectionId?: string, filters?: {
        userId?: string;
        updatedAfter?: string;
    }, excerptChars?: number): Promise<OutlineSearchResult & {
        excerpts: Array<{
            id: string;
            title: string;
            url: string;
            excerpt: string;
            updatedAt: string;
        }>;
    }>;
}
