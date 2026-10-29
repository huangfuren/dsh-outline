import type { OutlineClient, OutlineSearchHit, OutlineDocument, OutlineCollection } from './client.js';
export declare const SEARCH_MAX_LIMIT = 25;
/** all=true 时自动翻页的总条数上限（防超大结果集撑爆上下文）。 */
export declare const SEARCH_ALL_MAX = 100;
/**
 * all=true 且实例只能在本地按时间筛选（Outline 1.12 之前）时的**扫描**上限。
 *
 * 本地筛选会筛掉大部分候选，扫 100 篇往往只剩个位数命中；窗口放宽到 3 倍换取更多命中，
 * 返回条数仍受 SEARCH_ALL_MAX 约束（上下文成本由命中数决定，不由扫描量决定）。
 */
export declare const SEARCH_ALL_SCAN_MAX = 300;
/** all=true 翻页时同时在飞的请求数上限（前两页顺序探测，余下页面并发）。 */
export declare const SEARCH_ALL_CONCURRENCY = 4;
export declare const DOCUMENT_DEFAULT_MAX_LENGTH = 20000;
export declare const DOCUMENT_MAX_LENGTH_CAP = 200000;
/**
 * 本地轻量重排：Outline 服务端只按关键词相关度排序，这里补两点——
 * 标题命中权重高于摘要命中；一年内更新的文档有新近度加成（2 分随年龄递减到 0）。
 * 纯函数、稳定排序（同分保持服务端原序）、可单测；命中 ≤1 时原样返回。
 */
export declare function rerankHits(hits: OutlineSearchHit[], query: string): OutlineSearchHit[];
/** 同义词回退候选：整词命中词表优先，其次逐词替换；去重、排除原词、上限 3 个变体。 */
export declare function synonymVariants(query: string, synonyms: Record<string, string[]>): string[];
/** 本地保存默认目录名（相对 DSH 主目录；DSH 主目录不可得时回退到用户主目录）。 */
export declare const LOCAL_SAVE_DIRNAME = "outline-auto-saves";
/** 解析本地保存目录：配置优先，其次 $DSH_HOME/outline-auto-saves，最后 $HOME/outline-auto-saves。 */
export declare function resolveLocalSaveDir(configured: string | undefined, env?: NodeJS.ProcessEnv): string;
/**
 * 本地保存的安全兜底：这些目录（及其子目录）一律不写，避免把知识库导出物丢进系统目录。
 * 刻意**不带盘符**：判定时先剥掉 `C:` / `D:` 再比对，因此 Windows 装在非 C 盘时同样生效
 * （带盘符的列表在 `D:\Windows` 这类布局下会整体失效）。
 */
export declare const UNSAFE_SAVE_DIR_ROOTS: readonly string[];
/**
 * `outline_save_local` 的落盘目录校验。**这是安全带，不是沙箱** —— 目录本身由用户配置，
 * 只有目录不可信时才有意义；真正的边界仍是"文件系统权限"。
 * 拒绝三类目标：① 磁盘/文件系统/共享根目录（写入范围会失控）；② 已知系统目录（盘符无关）。
 * 判定对象是**折叠 `..` 之后的规范路径**，因此带 `..` 的写法绕不过去。
 * @returns 拒绝理由；可写时返回 null。
 */
export declare function checkSaveDir(dir: string): string | null;
/**
 * 根据平台调整文件名长度（Windows MAX_PATH=260 字符硬限）。
 * @returns 截断后的文件名（保留.md 后缀）
 */
export declare function capFileNameLength(dir: string, fileName: string): string;
/**
 * 把文件系统错误翻译为可操作提示（Windows/macOS 区分）。
 */
export declare function formatFsError(err: unknown, filePath: string): string;
/**
 * 把内容渲染为保存提示（追加在 outline_search / outline_get_document 结果末尾）。
 * dir 为空表示未配置保存目录 → 提示先配置；否则提示可回复"保存"触发 outline_save_local。
 * 纯函数，可单测。
 */
export declare function renderLocalSaveHint(dir: string, kind: 'search' | 'document'): string;
/** 文件名合法化：替换文件系统非法字符与首尾空白；空串回退为 untitled。对 Windows 保留设备名也进行保护（CON/NUL/PRN/COM1-9/LPT1-9）。 */
export declare function sanitizeFileName(title: string): string;
/** 把文档渲染为 Markdown 正文。 */
export declare function documentToMarkdown(doc: OutlineDocument): string;
/** 组装默认文件名：YYYY-MM-DD-<合法化标题>.md */
export declare function buildSaveFileName(title: string, now?: Date): string;
/** 冲突时追加序号：name.md → name-2.md → name-3.md …（最多尝试 50 次避免无限循环；存在性由传入的 exists 检查，便于测试）。 */
export declare function dedupeFileName(dir: string, fileName: string, exists: (p: string) => Promise<boolean>): Promise<string>;
/** 单次批量保存的文档数上限（防误传全库 id 拖垮 API）。 */
export declare const SAVE_MAX_DOCS = 50;
/** 把多篇文档合并为一份带目录的 Markdown（目录 → 各篇全文）。 */
export declare function mergeDocumentsToMarkdown(docs: OutlineDocument[], title: string): string;
export declare function outlineSaveLocalTool(getSaveDir: () => string, makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineSearchTool(makeClient: () => OutlineClient, defaultLimit: number, getSaveDir?: () => string, getSynonyms?: () => Record<string, string[]>): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineListUsersTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** outline_context_search 返回的单条带摘要原文的命中。 */
export interface ContextSearchHit {
    id: string;
    title: string;
    url: string;
    excerpt: string;
    updatedAt: string;
    snippet: string;
}
export declare function outlineContextSearchTool(makeClient: () => OutlineClient, defaultLimit: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineCountTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineGetDocumentTool(makeClient: () => OutlineClient, getSaveDir?: () => string): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 审批提示文案：完整路径 + 标题 + 内容预览（前 100 字，纯函数可单测）。 */
export declare function buildCreateApprovalReason(args: {
    collectionId?: string;
    title?: string;
    text?: string;
}, collectionName?: string, resolvedPath?: string[]): string;
/** 白名单条目：一个可写目录路径。segments 为空表示整个集合可写。 */
export interface WritablePathEntry {
    collectionName: string;
    segments: string[];
}
/** 解析可写目录配置（逗号分隔，反斜杠视为层级分隔）：`集合名` 或 `集合名/目录 A/子目录 B`。 */
export declare function parseWritablePaths(raw: string): WritablePathEntry[];
/** 写入目标的两种形态：创建（目标位置）与更新/删除（目标文档）。 */
export type WritePathTarget = {
    kind: 'create';
    collectionId: string;
    parentDocumentId?: string;
} | {
    kind: 'doc';
    docId: string;
};
/**
 * 目录级写入守卫：目标路径必须落在白名单条目内（前缀匹配，fail-closed）。
 * - 白名单为空 → 拒绝（插件为只读模式）
 * - 目标路径解析失败（集合/文档不可见）→ 拒绝
 * - 条目 `集合A/目录1` 匹配 `[集合A, 目录1, …任意子级]`；`集合A` 匹配整个集合
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export declare function resolvePathGuard(client: OutlineClient, target: WritePathTarget, entries: WritablePathEntry[], collections: OutlineCollection[]): Promise<string | null>;
/** 标准需求文档模板（Markdown）。
 * 排版约定：条目类章节（需求或目标/交付物/交付标准/潜在风险点/工作思路）如有多个条目，
 * 必须换行并逐条编号（1、2、3、… 一点一行），不要挤成一段。 */
export declare const REQUIREMENT_DOC_TEMPLATE: string;
/** 模板的章节清单（供 AI 核对是否写全）。 */
export declare const REQUIREMENT_DOC_SECTIONS: string[];
export declare function outlineDocTemplateTool(): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * 基础写入守卫：必须确认集合存在且 token 有写权限。
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export declare function resolveWriteGuard(collections: OutlineCollection[], collectionId: string): string | null;
export declare function outlineResolvePathTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineListCollectionsTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * 写工具的已声明参数白名单。
 *
 * 为什么必须自查：宿主 `parameterSchemaSpecToJsonSchema`（dsh-tools 0.2.0-rc.2）生成的参数
 * schema 是 `{type,properties,required}`，**不带 `additionalProperties: false`** ——
 * 参数面默认开放，未声明的键能通过校验、不会报错。而各工具的 `execute` 只读取自己认识的字段，
 * 于是「模型传 `append: true` 以为在追加 → 实际走整体覆盖并返回成功」这类
 * **静默成功但语义被丢弃**的情况就会发生；对写操作而言这是数据损坏路径。
 * 因此写工具在 `execute` 入口显式拒绝未知键（fail-closed），而不是静默忽略。
 */
export declare const CREATE_ARG_KEYS: readonly ["collectionId", "parentDocumentId", "title", "text", "publish"];
export declare const UPDATE_ARG_KEYS: readonly ["id", "title", "text", "append", "publish"];
export declare const DELETE_ARG_KEYS: readonly ["id"];
/** 前缀式截断告警的触发门槛：按前缀判定时，至少要"少这么多字符"才值得打扰用户。 */
export declare const TRUNCATION_PREFIX_MIN_LOST = 1000;
/**
 * 识别「把读取时被截断的正文写回」这一破坏性模式（读→改→写链路的静默丢内容路径）。
 *
 * 判据（任一命中即告警）：
 * ① 新正文长度恰为 `outline_get_document` 的默认上限 20000，且原文更长 —— 典型的默认参数截断痕迹；
 * ② 新正文是原文的**精确前缀**且少掉 `TRUNCATION_PREFIX_MIN_LOST`（1000）字符以上 ——
 *    截断读出的内容按定义就是原文前缀，且丢失量足够大。
 *
 * 纯函数，可单测。返回告警文案（含确切字符数）供审批 reason 使用；不疑似截断时返回 null。
 * 注意：判定为 `ask` 而非 `deny` —— 故意把长文裁剪到前 N 字符是合法诉求，交由用户带数据确认。
 */
export declare function detectTruncatedRewrite(originalText: string, nextText: string): string | null;
/**
 * 拒绝未声明的写入参数。纯函数（直接抛错），可单测。
 * @param toolName 工具名（用于错误文案）
 * @param args 模型传入的原始参数
 * @param allowed 已声明参数键
 */
export declare function assertKnownWriteArgs(toolName: string, args: Record<string, unknown>, allowed: readonly string[]): void;
export declare function outlineCreateTool(makeClient: () => OutlineClient, getWritablePaths: () => string): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineUpdateDocumentTool(makeClient: () => OutlineClient, getWritablePaths: () => string): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * 二次审批回调：由 index.ts 接线到 ctx.approval.request，返回是否 allowed-once。
 * `exec.signal` 必须一并透传 —— 宿主的 approval.request 用它做协作式取消竞速
 * （`decide()` 在 signal 已中止时直接返回 cancelled；宿主自己的 serviceAsk 也是这么传的）。
 * 不透传的话，用户在第二次弹窗期间取消本轮，这个 promise 不会以 cancelled 收敛。
 */
export type DeleteApprovalRequester = (reason: string, exec: {
    agent?: unknown;
    callId?: unknown;
    signal?: unknown;
}) => Promise<boolean>;
export declare function outlineDeleteTool(makeClient: () => OutlineClient, getWritablePaths: () => string, requestApproval: DeleteApprovalRequester): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineListChildrenTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
