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
/** 搜索结果：命中列表 + 该关键词在知识库中的匹配总数（pagination.total）。 */
export interface OutlineSearchResult {
    total: number;
    hits: OutlineSearchHit[];
    /** 多词查询零命中时自动用首词重试成功后，记录实际生效的首词。 */
    retriedWith?: string;
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
/** outline_create 返回：创建后的文档信息。 */
export interface OutlineCreateResult {
    id: string;
    url: string;
    title: string;
    published: boolean;
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
    /** 更新已有文档（至少提供 title 或 text 之一）。 */
    updateDocument(id: string, input: {
        title?: string;
        text?: string;
    }): Promise<OutlineCreateResult>;
    /** 删除文档（本实例无回收站端点，为硬删；调用方必须已通过双重审批）。 */
    deleteDocument(id: string): Promise<{
        success: boolean;
    }>;
    getDocument(id: string): Promise<OutlineDocument>;
    /** 列出某父文档下的直接子文档（用于路径定位；本地匹配名称，避免搜索分词歧义）。 */
    listChildDocuments(parentDocumentId: string, pageSize?: number): Promise<OutlineSearchHit[]>;
    /** 解析一个文档的完整路径：返回 [集合名, 顶级目录, …, 文档名]（自顶向下）。 */
    resolveDocumentPath(docId: string): Promise<string[]>;
}
