import type { OutlineClient, OutlineSearchHit, OutlineDocument, OutlineCollection } from './client.js';
export declare const SEARCH_MAX_LIMIT = 25;
/** all=true 时自动翻页的总条数上限（防超大结果集撑爆上下文）。 */
export declare const SEARCH_ALL_MAX = 100;
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
 * 把内容渲染为保存提示（追加在 outline_search / outline_get_document 结果末尾）。
 * dir 为空表示未配置保存目录 → 提示先配置；否则提示可回复"保存"触发 outline_save_local。
 * 纯函数，可单测。
 */
export declare function renderLocalSaveHint(dir: string, kind: 'search' | 'document'): string;
/** 文件名合法化：替换文件系统非法字符与首尾空白；空串回退为 untitled。 */
export declare function sanitizeFileName(title: string): string;
/** 把文档渲染为 Markdown 正文。 */
export declare function documentToMarkdown(doc: OutlineDocument): string;
/** 组装默认文件名：YYYY-MM-DD-<合法化标题>.md */
export declare function buildSaveFileName(title: string, now?: Date): string;
/** 冲突时追加序号：name.md → name-2.md → name-3.md …（存在性由传入的 exists 检查，便于测试）。 */
export declare function dedupeFileName(dir: string, fileName: string, exists: (p: string) => Promise<boolean>): Promise<string>;
/** 单次批量保存的文档数上限（防误传全库 id 拖垮 API）。 */
export declare const SAVE_MAX_DOCS = 50;
/** 把多篇文档合并为一份带目录的 Markdown（目录 → 各篇全文）。 */
export declare function mergeDocumentsToMarkdown(docs: OutlineDocument[], title: string): string;
export declare function outlineSaveLocalTool(getSaveDir: () => string, makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineSearchTool(makeClient: () => OutlineClient, defaultLimit: number, getSaveDir?: () => string, getSynonyms?: () => Record<string, string[]>): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineListUsersTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
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
/** 解析可写目录配置（逗号分隔）：`集合名` 或 `集合名/目录A/子目录B`。 */
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
export declare function outlineCreateTool(makeClient: () => OutlineClient, getWritablePaths: () => string): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineUpdateDocumentTool(makeClient: () => OutlineClient, getWritablePaths: () => string): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 二次审批回调：由 index.ts 接线到 ctx.approval.request，返回是否 allowed-once。 */
export type DeleteApprovalRequester = (reason: string, exec: {
    agent?: unknown;
    callId?: unknown;
}) => Promise<boolean>;
export declare function outlineDeleteTool(makeClient: () => OutlineClient, getWritablePaths: () => string, requestApproval: DeleteApprovalRequester): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function outlineListChildrenTool(makeClient: () => OutlineClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
