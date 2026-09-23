import { OutlineApiError, throwForStatus } from './errors.js'

/**
 * 按并发上限批量执行异步任务，返回值保持入参顺序（任一任务抛错则整体抛出，由调用方决定降级）。
 * 用于把「N 次串行往返」压成「1 次 + 并发」：结果与串行完全一致，只是等待时间被重叠掉。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Outline 服务端分页硬上限：limit > 100 会被以 400 "Pagination limit is too large" 拒绝。 */
export const OUTLINE_MAX_PAGE_SIZE = 100

export interface OutlineSearchHit {
  id: string
  title: string
  url: string
  snippet: string
  collectionId: string
  updatedAt: string
  parentDocumentId?: string
  /** 作者显示名（取自搜索响应的 createdBy.name；缺省时回退 users.list 映射）。 */
  authorName?: string
}

/** 搜索结果：命中列表 + 该关键词在知识库中的匹配总数（pagination.total）。 */
export interface OutlineSearchResult {
  total: number
  hits: OutlineSearchHit[]
  /** 多词查询零命中时自动用首词重试成功后，记录实际生效的首词。 */
  retriedWith?: string
}

export interface OutlineDocument {
  id: string
  title: string
  url: string
  text: string
  updatedAt: string
  collectionId?: string
  parentDocumentId?: string
}

/** Outline 集合（collections.list 条目）。documentCount 部分实例可能不返回。 */
export interface OutlineCollection {
  id: string
  name: string
  permission: string
  documentCount?: number
}

/** outline_create 返回：创建后的文档信息。 */
export interface OutlineCreateResult {
  id: string
  url: string
  title: string
  published: boolean
}

/** Outline 用户（users.list 条目）。 */
export interface OutlineUser {
  id: string
  name: string
  email?: string
}

export interface OutlineClientOptions {
  baseUrl: string
  apiToken: string
  timeoutMs?: number
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
}

export class OutlineClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly baseUrl: string
  private readonly apiToken: string
  /** getDocument 的短期缓存（key = 文档 id），避免会话内重复读取同一文档反复请求 API。 */
  private readonly docCache = new Map<string, { expires: number; doc: OutlineDocument }>()
  private static readonly DEFAULT_CACHE_TTL_MS = 60_000
  /** 文档缓存条数上限：超限时按插入顺序淘汰最旧条目，防止长时间运行内存膨胀。 */
  private static readonly DOC_CACHE_MAX_ENTRIES = 200
  /** 429 限流自动重试次数（指数退避，每次最多退避 5 秒）。 */
  private static readonly MAX_RETRIES = 3
  /** listCollections 的短期缓存，供审批钩子解析集合名。 */
  private collectionsCache: { expires: number; collections: OutlineCollection[] } | null = null
  /** listUsers 的短期缓存（id→name 映射 + 姓名解析复用）。 */
  private usersCache: { expires: number; users: OutlineUser[] } | null = null
  /** searchDocuments 结果的短期缓存（key = 归一化查询参数），同 query 连续提问不重复打 API。 */
  private readonly searchCache = new Map<string, { expires: number; result: OutlineSearchResult }>()
  private static readonly SEARCH_CACHE_MAX_ENTRIES = 50
  /** Outline 服务端分页上限（limit > 100 直接返回 400 "Pagination limit is too large"）。 */
  private static readonly MAX_PAGE_SIZE = OUTLINE_MAX_PAGE_SIZE
  /** 单次工具调用内同时在飞的请求数上限：压住并发以免瞬时打爆上游（触发 429 反而更慢）。 */
  private static readonly MAX_CONCURRENCY = 4

  constructor(options: OutlineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.assertAllowedUrl(this.baseUrl)
    this.apiToken = options.apiToken
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15000
    this.cacheTtlMs = options.cacheTtlMs ?? OutlineClient.DEFAULT_CACHE_TTL_MS
  }

  /** 安全校验：拒绝公网明文 http（避免 Token 明文传输），允许 https 以及本地/内网私有地址。 */
  private assertAllowedUrl(baseUrl: string): void {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error(`dsh-outline 的 baseUrl 无法解析：${baseUrl}。请填写合法的 Outline 根地址。`)
    }
    if (parsed.protocol === 'https:') return
    // Strip brackets from IPv6 for comparison: [::1] → ::1 (Node keeps brackets in hostname!)
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    const isPrivate = ipv4 !== null && (
      Number(ipv4[1]) === 10
      || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
      || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
      || Number(ipv4[1]) === 127
    )
    if (isLocal || isPrivate) return
    throw new Error(
      `dsh-outline 拒绝非 HTTPS 地址：${baseUrl}。为避免 Token 明文传输，公网地址必须使用 https://（localhost、::1、127.0.0.1、内网私有地址除外）。`,
    )
  }

  /** 去掉 Outline 片段/标题里的 HTML 标签（如 <b>），避免原样渲染进聊天。 */
  private static stripHtml(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** 把 Outline API 返回的相对文档路径（如 /doc/xxx）解析为可点击的绝对地址。 */
  private absolutize(url: string): string {
    if (!url) return ''
    if (/^https?:\/\//i.test(url)) return url
    return `${this.baseUrl}${url.startsWith('/') ? url : '/' + url}`
  }

  /** 请求并返回完整 JSON 响应体（data + pagination 等元数据）。 */
  private async requestJson(path: string, body: Record<string, unknown>, retries = 0): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      const cause = error instanceof Error ? error.message : String(error)
      throw new OutlineApiError(
        'network',
        aborted
          ? `Outline 请求超时（${this.timeoutMs}ms）：${url}`
          : `无法连接 Outline（${url}）：${cause}。请确认 baseUrl 正确且网络可达。`,
      )
    } finally {
      clearTimeout(timer)
    }
    const bodyText = await response.text().catch(() => '')
    if (!response.ok) {
      // 429 限流：指数退避自动重试（最多 3 次）；尊重 Retry-After，仍失败则抛出 rate-limited
      if (response.status === 429 && retries < OutlineClient.MAX_RETRIES) {
        const retryAfter = Number(response.headers?.get?.('retry-after') ?? '')
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter * 1000, 5000)
          : Math.min(500 * 2 ** retries, 5000)
        await new Promise((resolve) => setTimeout(resolve, delay))
        return this.requestJson(path, body, retries + 1)
      }
      throwForStatus(response.status, bodyText)
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      throw new OutlineApiError('invalid-response', 'Outline 返回了无法解析的响应。')
    }
    return json
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const json = await this.requestJson(path, body)
    const data = json.data
    if (data === undefined) throw new OutlineApiError('invalid-response', 'Outline 响应缺少 data 字段。')
    return data as T
  }

  /**
   * 通用分页拉取：先取第一页拿到 total，再按需并发补齐后续页（并发上限 MAX_CONCURRENCY）。
   * 结果按 offset 顺序拼接 —— 与逐页串行拉取逐条等价（同集合、同顺序、不漏项），
   * 但把 N 次串行往返压成「1 次 + 并发」，大集合/多用户实例下省掉 N-1 个 RTT。
   * 页偏移按上一页实际返回条数推进：服务端若把 limit 压得更小也不会漏页。
   */
  private async fetchAllPages<T>(
    fetchPage: (offset: number, pageSize: number) => Promise<{ items: T[]; total: number }>,
    pageSize: number,
  ): Promise<T[]> {
    const first = await fetchPage(0, pageSize)
    if (first.items.length === 0) return []
    const step = first.items.length > 0 ? first.items.length : pageSize
    const total = Math.max(first.total, first.items.length)
    if (first.items.length >= total) return first.items
    const offsets: number[] = []
    for (let offset = step; offset < total; offset += step) offsets.push(offset)
    const rest = await mapWithConcurrency(offsets, OutlineClient.MAX_CONCURRENCY, (offset) => fetchPage(offset, pageSize))
    const items = [...first.items]
    for (const page of rest) items.push(...page.items)
    return items
  }

  async searchDocuments(query: string, limit: number, collectionId?: string, filters?: { userId?: string; updatedAfter?: string }, offset = 0): Promise<OutlineSearchResult> {
    // 结果短期缓存：同 query 连续提问不重复打 API；写操作（create/update/delete）统一 clear 失效。
    const cacheKey = JSON.stringify([query, limit, collectionId ?? '', filters?.userId ?? '', filters?.updatedAfter ?? '', offset])
    const cachedSearch = this.searchCache.get(cacheKey)
    if (cachedSearch !== undefined && cachedSearch.expires > Date.now()) return cachedSearch.result
    const json = await this.requestJson(`/api/documents.search`, {
      query,
      limit,
      ...(offset > 0 ? { offset } : {}),
      ...(collectionId !== undefined && collectionId !== '' ? { collectionId } : {}),
      ...(filters?.userId !== undefined && filters.userId !== '' ? { userId: filters.userId } : {}),
      ...(filters?.updatedAfter !== undefined && filters.updatedAfter !== '' ? { updatedAfter: filters.updatedAfter } : {}),
    })
    const data = Array.isArray(json.data) ? json.data : []
    const pagination = (json.pagination ?? {}) as { total?: unknown }
    const mapped = data.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>
      const document = (record.document ?? {}) as Record<string, unknown>
      // 作者名优先从搜索响应里直接取（Outline 在 document.createdBy 里带回完整用户对象），
      // 这样无需为「显示作者」额外拉一次 users.list；缺失时再退回 id → users.list 映射。
      const createdBy = (document.createdBy ?? record.createdBy) as Record<string, unknown> | undefined
      const createdName = typeof createdBy?.name === 'string' && createdBy.name.trim() !== ''
        ? OutlineClient.stripHtml(createdBy.name)
        : undefined
      const rawUser = (document.user ?? record.user ?? {}) as Record<string, unknown>
      const authorId = typeof rawUser.id === 'string' && rawUser.id !== '' ? rawUser.id : undefined
      const hit: OutlineSearchHit = {
        id: typeof document.id === 'string' ? document.id : '',
        title: OutlineClient.stripHtml(typeof document.title === 'string' ? document.title : '(无标题)'),
        url: this.absolutize(typeof document.url === 'string' ? document.url : ''),
        snippet: typeof record.context === 'string' ? record.context : '',
        collectionId: typeof document.collectionId === 'string' ? document.collectionId : '',
        updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : '',
        ...(document.parentDocumentId !== undefined && document.parentDocumentId !== null
          ? { parentDocumentId: String(document.parentDocumentId) }
          : {}),
        ...(createdName !== undefined ? { authorName: createdName } : {}),
      }
      return { hit, authorId: createdName !== undefined ? undefined : authorId }
    })
    const hits = mapped.map((m) => m.hit)
    // 解析作者名（响应未带回名字时才拉 users.list；失败则降级，不阻断搜索）。
    const authorIds = [...new Set(mapped.map((m) => m.authorId).filter((x): x is string => x !== undefined))]
    if (authorIds.length > 0) {
      const nameMap = await this.userNameMap()
      for (const m of mapped) {
        if (m.authorId !== undefined) m.hit.authorName = nameMap.get(m.authorId)
      }
    }
    const total = typeof pagination.total === 'number' ? pagination.total : hits.length
    const result: OutlineSearchResult = { total, hits }
    this.searchCache.set(cacheKey, { expires: Date.now() + this.cacheTtlMs, result })
    if (this.searchCache.size > OutlineClient.SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.searchCache.keys().next().value
      if (oldest !== undefined) this.searchCache.delete(oldest)
    }
    return result
  }

  /** 写操作后失效搜索缓存（结果可能随增删改变化）。 */
  private invalidateCaches(): void {
    this.collectionsCache = null
    this.searchCache.clear()
  }

  /** 统计 Outline 知识库文档总数（documents.list 分页 total；不含已删除/回收站文档）。 */
  async countDocuments(filters: Record<string, unknown> = {}): Promise<number> {
    const json = await this.requestJson(`/api/documents.list`, { limit: 1, ...filters })
    const pagination = (json.pagination ?? {}) as { total?: unknown }
    return typeof pagination.total === 'number' ? pagination.total : 0
  }

  /** 列出当前 token 可见的集合（短期缓存）。注：实例要求 collections.list 带查询串。 */
  async listCollections(force = false): Promise<OutlineCollection[]> {
    const cached = this.collectionsCache
    if (!force && cached !== null && cached !== undefined && cached.expires > Date.now()) return cached.collections
    // Outline 分页：先取第一页拿 total，再并发补齐余下页面（防止集合数超过一页时漏集合）
    const raw = await this.fetchAllPages<Record<string, unknown>>(
      async (offset, pageSize) => {
        const json = await this.requestJson(`/api/collections.list?limit=${pageSize}&offset=${offset}`, {})
        const data = Array.isArray(json.data) ? json.data : []
        const pagination = (json.pagination ?? {}) as { total?: unknown }
        return {
          items: data.map((item) => (item ?? {}) as Record<string, unknown>),
          total: typeof pagination.total === 'number' ? pagination.total : data.length,
        }
      },
      OutlineClient.MAX_PAGE_SIZE,
    )
    const collections: OutlineCollection[] = raw.map((c) => ({
      id: typeof c.id === 'string' ? c.id : '',
      name: typeof c.name === 'string' ? c.name : '(未命名集合)',
      permission: typeof c.permission === 'string' ? c.permission : '',
      ...(typeof c.documentCount === 'number' ? { documentCount: c.documentCount } : {}),
    }))
    this.collectionsCache = { expires: Date.now() + this.cacheTtlMs, collections }
    return collections
  }

  /** 列出当前 token 可见的用户（短期缓存）。用于"某人写的文档"姓名→id 解析。 */
  async listUsers(force = false): Promise<OutlineUser[]> {
    const cached = this.usersCache
    if (!force && cached !== null && cached.expires > Date.now()) return cached.users
    // 先取第一页拿 total，再并发补齐余下页面（大工作区下避免 N 次串行往返）
    const raw = await this.fetchAllPages<Record<string, unknown>>(
      async (offset, pageSize) => {
        const json = await this.requestJson(`/api/users.list?limit=${pageSize}&offset=${offset}`, {})
        const data = Array.isArray(json.data) ? json.data : []
        const pagination = (json.pagination ?? {}) as { total?: unknown }
        return {
          items: data.map((item) => (item ?? {}) as Record<string, unknown>),
          total: typeof pagination.total === 'number' ? pagination.total : data.length,
        }
      },
      OutlineClient.MAX_PAGE_SIZE,
    )
    const users: OutlineUser[] = raw.map((u) => ({
      id: typeof u.id === 'string' ? u.id : '',
      name: typeof u.name === 'string' ? u.name : '(未命名用户)',
      ...(typeof u.email === 'string' && u.email !== '' ? { email: u.email } : {}),
    }))
    this.usersCache = { expires: Date.now() + this.cacheTtlMs, users }
    return users
  }

  /**
   * 按姓名或邮箱找用户：先精确匹配（唯一才算），再子串包含匹配（不区分大小写）。
   * 返回所有匹配（0 个 = 未找到；>1 个 = 有歧义，由调用方列出候选）。
   */
  async findUsers(query: string): Promise<OutlineUser[]> {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    let users: OutlineUser[]
    try {
      users = await this.listUsers()
    } catch {
      // users.list 不可用时降级：返回空，让上层提示"未找到作者/可先用 outline_list_users 排查"
      return []
    }
    const exact = users.filter((u) => u.name.toLowerCase() === q || u.email?.toLowerCase() === q)
    if (exact.length > 0) return exact
    return users.filter((u) => u.name.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) === true)
  }

  /** id→姓名映射（基于 users.list 缓存）。users.list 不可用时返回空映射（fail-open）。 */
  private async userNameMap(): Promise<Map<string, string>> {
    try {
      const users = await this.listUsers()
      return new Map(users.map((u) => [u.id, u.name]))
    } catch {
      return new Map()
    }
  }

  /** 在指定集合创建文档（默认发布；可指定父文档实现嵌套）。 */
  async createDocument(input: { collectionId: string; title: string; text: string; publish?: boolean; parentDocumentId?: string }): Promise<OutlineCreateResult> {
    const data = await this.request<Record<string, unknown>>(`/api/documents.create`, {
      collectionId: input.collectionId,
      title: input.title,
      text: input.text,
      publish: input.publish ?? true,
      ...(input.parentDocumentId !== undefined && input.parentDocumentId !== '' ? { parentDocumentId: input.parentDocumentId } : {}),
    })
    // 新建后搜索结果与集合数都变化，统一失效缓存
    this.invalidateCaches()
    return {
      id: typeof data.id === 'string' ? data.id : '',
      url: this.absolutize(typeof data.url === 'string' ? data.url : ''),
      title: OutlineClient.stripHtml(typeof data.title === 'string' ? data.title : input.title),
      published: typeof data.published === 'boolean' ? data.published : true,
    }
  }

  /** 更新已有文档（至少提供 title 或 text 之一）。 */
  async updateDocument(id: string, input: { title?: string; text?: string }): Promise<OutlineCreateResult> {
    const payload: Record<string, unknown> = { id }
    if (input.title !== undefined && input.title !== '') payload.title = input.title
    if (input.text !== undefined && input.text !== '') payload.text = input.text
    const data = await this.request<Record<string, unknown>>(`/api/documents.update`, payload)
    // 更新后清文档缓存与集合/搜索缓存，避免 60s 内读到旧内容
    this.docCache.delete(id)
    this.invalidateCaches()
    return {
      id: typeof data.id === 'string' ? data.id : id,
      url: this.absolutize(typeof data.url === 'string' ? data.url : ''),
      title: OutlineClient.stripHtml(typeof data.title === 'string' ? data.title : input.title ?? id),
      published: typeof data.published === 'boolean' ? data.published : true,
    }
  }

  /** 删除文档（本实例无回收站端点，为硬删；调用方必须已通过双重审批）。 */
  async deleteDocument(id: string): Promise<{ success: boolean }> {
    // 本实例 delete 响应形如 {success:true, ok:true}，无 data 字段 → 用 requestJson 直接读
    const json = await this.requestJson(`/api/documents.delete`, { id })
    // 删除后清文档缓存与集合/搜索缓存（文档数/可见性变化）
    this.docCache.delete(id)
    this.invalidateCaches()
    return { success: json.success !== false }
  }

  async getDocument(id: string): Promise<OutlineDocument> {
    const cached = this.docCache.get(id)
    if (cached !== undefined && cached.expires > Date.now()) return cached.doc
    const data = await this.request<Record<string, unknown>>(`/api/documents.info`, { id })
    const doc: OutlineDocument = {
      id: typeof data.id === 'string' ? data.id : id,
      title: OutlineClient.stripHtml(typeof data.title === 'string' ? data.title : '(无标题)'),
      url: this.absolutize(typeof data.url === 'string' ? data.url : ''),
      text: typeof data.text === 'string' ? data.text : '',
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      ...(data.collectionId !== undefined && data.collectionId !== null ? { collectionId: String(data.collectionId) } : {}),
      ...(data.parentDocumentId !== undefined && data.parentDocumentId !== null
        ? { parentDocumentId: String(data.parentDocumentId) }
        : {}),
    }
    this.docCache.set(id, { expires: Date.now() + this.cacheTtlMs, doc })
    // 超限时淘汰最旧条目（Map 保持插入顺序）
    if (this.docCache.size > OutlineClient.DOC_CACHE_MAX_ENTRIES) {
      const oldest = this.docCache.keys().next().value
      if (oldest !== undefined) this.docCache.delete(oldest)
    }
    return doc
  }

  /** 列出某父文档下的直接子文档（用于路径定位；本地匹配名称，避免搜索分词歧义）。 */
  async listChildDocuments(parentDocumentId: string, pageSize = 100): Promise<OutlineSearchHit[]> {
    // 先取第一页拿 total，再并发补齐余下页面（防止子文档超过一页时漏项）
    const docs = await this.fetchAllPages<Record<string, unknown>>(
      async (offset, size) => {
        const json = await this.requestJson(`/api/documents.list`, {
          parentDocumentId,
          limit: size,
          ...(offset > 0 ? { offset } : {}),
        })
        const data = Array.isArray(json.data) ? json.data : []
        const pagination = (json.pagination ?? {}) as { total?: unknown }
        return {
          items: data.map((item) => (item ?? {}) as Record<string, unknown>),
          total: typeof pagination.total === 'number' ? pagination.total : data.length,
        }
      },
      pageSize,
    )
    return docs.map((d) => ({
      id: typeof d.id === 'string' ? d.id : '',
      title: OutlineClient.stripHtml(typeof d.title === 'string' ? d.title : '(无标题)'),
      url: this.absolutize(typeof d.url === 'string' ? d.url : ''),
      snippet: '',
      collectionId: typeof d.collectionId === 'string' ? d.collectionId : '',
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
      ...(d.parentDocumentId !== undefined && d.parentDocumentId !== null ? { parentDocumentId: String(d.parentDocumentId) } : {}),
    }))
  }

  /** 解析一个文档的完整路径：返回 [集合名, 顶级目录, …, 文档名]（自顶向下）。 */
  async resolveDocumentPath(docId: string): Promise<string[]> {
    const titles: string[] = []
    let collectionId: string | undefined
    let currentId = docId
    const seen = new Set<string>()
    while (currentId !== undefined && currentId !== '' && !seen.has(currentId)) {
      seen.add(currentId)
      const doc = await this.getDocument(currentId)
      collectionId ??= doc.collectionId
      titles.unshift(doc.title)
      currentId = doc.parentDocumentId ?? ''
    }
    if (collectionId !== undefined) {
      const collections = await this.listCollections()
      const coll = collections.find((c) => c.id === collectionId)
      if (coll !== undefined) titles.unshift(coll.name)
    }
    return titles
  }

  /**
   * 拉取一篇文档的摘要原文（前 N 字符的纯文本正文）。
   * 复用 getDocument 的 60s 缓存，避免 context_search 重复打 API。
   * 超长文本截断后追加 …标记。
   */
  async getDocumentExcerpt(id: string, maxChars = 800): Promise<{ id: string; title: string; url: string; excerpt: string; updatedAt: string }> {
    const doc = await this.getDocument(id)
    const excerpt = doc.text.length > maxChars ? doc.text.slice(0, maxChars).trimEnd() + '…' : doc.text
    return { id: doc.id, title: doc.title, url: doc.url, excerpt, updatedAt: doc.updatedAt }
  }

  /**
   * 搜索并批量拉取命中文档的摘要原文（供 outline_context_search 工具使用）。
   * 并发拉取（上限 MAX_CONCURRENCY），复用 getDocument 缓存。
   * @returns 搜索结果 + 每条命中附带 excerpt 字段（文档正文前 N 字符）
   */
  async searchWithExcerpts(
    query: string,
    limit: number,
    collectionId?: string,
    filters?: { userId?: string; updatedAfter?: string },
    excerptChars = 800,
  ): Promise<OutlineSearchResult & { excerpts: Array<{ id: string; title: string; url: string; excerpt: string; updatedAt: string }> }> {
    const result = await this.searchDocuments(query, limit, collectionId, filters)
    if (result.hits.length === 0) {
      return { ...result, excerpts: [] }
    }
    const excerpts = await mapWithConcurrency(
      result.hits,
      OutlineClient.MAX_CONCURRENCY,
      (hit) => this.getDocumentExcerpt(hit.id, excerptChars),
    )
    return { ...result, excerpts }
  }
}