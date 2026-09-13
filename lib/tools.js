import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mapWithConcurrency, OUTLINE_MAX_PAGE_SIZE } from './client.js';
export const SEARCH_MAX_LIMIT = 25;
/** all=true 时自动翻页的总条数上限（防超大结果集撑爆上下文）。 */
export const SEARCH_ALL_MAX = 100;
/** all=true 翻页时同时在飞的请求数上限（前两页顺序探测，余下页面并发）。 */
export const SEARCH_ALL_CONCURRENCY = 4;
export const DOCUMENT_DEFAULT_MAX_LENGTH = 20000;
export const DOCUMENT_MAX_LENGTH_CAP = 200000;
/** 转义链接文字里的 Markdown 特殊字符，避免标题含 []() 时破坏 [title](url) 链接。 */
function escapeLinkText(text) {
    return text.replace(/[\\[\]]/g, (ch) => (ch === '\\' ? '\\\\' : '\\' + ch));
}
/** URL 含空格或括号时用 <> 包裹，保证 markdown 链接闭合正确。 */
function wrapUrl(url) {
    return /[\s()]/.test(url) ? `<${url}>` : url;
}
/**
 * 本地轻量重排：Outline 服务端只按关键词相关度排序，这里补两点——
 * 标题命中权重高于摘要命中；一年内更新的文档有新近度加成（2 分随年龄递减到 0）。
 * 纯函数、稳定排序（同分保持服务端原序）、可单测；命中 ≤1 时原样返回。
 */
export function rerankHits(hits, query) {
    if (hits.length <= 1)
        return hits;
    const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '');
    if (terms.length === 0)
        return hits;
    const now = Date.now();
    const scored = hits.map((hit, index) => {
        let score = 0;
        const title = hit.title.toLowerCase();
        const snippet = hit.snippet.toLowerCase();
        for (const term of terms) {
            if (title.includes(term))
                score += 10;
            if (snippet.includes(term))
                score += 4;
        }
        const updated = Date.parse(hit.updatedAt);
        if (!Number.isNaN(updated)) {
            const ageDays = Math.max(0, (now - updated) / 86_400_000);
            score += Math.max(0, 2 - ageDays / 365);
        }
        return { hit, score, index };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((entry) => entry.hit);
}
/** 同义词回退候选：整词命中词表优先，其次逐词替换；去重、排除原词、上限 3 个变体。 */
export function synonymVariants(query, synonyms) {
    const trimmed = query.trim();
    if (trimmed === '')
        return [];
    const terms = trimmed.split(/\s+/);
    const out = [];
    const push = (value) => {
        const v = value.trim();
        if (v !== '' && v !== trimmed && !out.includes(v))
            out.push(v);
    };
    for (const alt of synonyms[trimmed] ?? [])
        push(alt);
    for (const term of terms) {
        for (const alt of synonyms[term] ?? []) {
            // 多词查询：替换其中一个词生成新查询（"部署 规范" 且 部署→上线 → "上线 规范"）
            if (terms.length > 1)
                push(terms.map((t) => (t === term ? alt : t)).join(' '));
            else
                push(alt);
        }
    }
    return out.slice(0, 3);
}
function renderSearchResults(result, allMode = false) {
    const { total, hits } = result;
    if (hits.length === 0) {
        return total > 0 ? `该关键词共匹配 ${total} 篇文档，但未返回可展示的结果。` : '未找到匹配文档，可尝试更换关键词（如去掉停用词、改用更短的词）。';
    }
    const fetchedAll = allMode && hits.length >= total;
    const head = fetchedAll
        ? `已抓全部 ${hits.length} 篇（关键词共匹配 ${total} 篇）：`
        : `找到 ${hits.length} 篇文档${total > hits.length ? `（关键词共匹配 ${total} 篇，显示前 ${hits.length} 篇）` : ''}：`;
    // 仍有更多可翻页时，提示用户如何让 AI 翻页（Outline 不支持 offset 时该提示会引导走 all 模式重抓）。
    const tail = (!fetchedAll && total > hits.length)
        ? `\n\n（还有 ${total - hits.length} 篇未显示。回复"查看下一页"或"全部"可让 AI 用 outline_search 的 offset / all 参数继续获取。）`
        : '';
    const lines = hits.map((hit) => {
        const meta = hit.snippet.length > 0 ? ` — ${hit.snippet}` : '';
        const author = hit.authorName !== undefined && hit.authorName !== '' ? `（作者：${hit.authorName}）` : '';
        return `- [${escapeLinkText(hit.title)}](${wrapUrl(hit.url)})${meta}（id: ${hit.id}）${author}`;
    });
    return `${head}\n${lines.join('\n')}${tail}\n\n如需查看某篇全文，请使用 outline_get_document 工具（参数 id）。`;
}
function renderDocument(doc, truncated) {
    const note = truncated ? '\n\n…（内容过长已截断，可增大 maxLength 参数）' : '';
    return `# ${doc.title}\n\n${doc.url}\n\n${doc.text}${note}`;
}
// ---------------------------------------------------------------------------
// 本地保存（localSaveDir + outline_save_local）
// ---------------------------------------------------------------------------
/** 本地保存默认目录名（相对 DSH 主目录；DSH 主目录不可得时回退到用户主目录）。 */
export const LOCAL_SAVE_DIRNAME = 'outline-auto-saves';
/** 解析本地保存目录：配置优先，其次 $DSH_HOME/outline-auto-saves，最后 $HOME/outline-auto-saves。 */
export function resolveLocalSaveDir(configured, env = process.env) {
    const cfg = (configured ?? '').trim();
    if (cfg !== '')
        return cfg;
    const dshHome = (env.DSH_HOME ?? '').trim();
    const base = dshHome !== '' ? dshHome : (env.USERPROFILE ?? env.HOME ?? '.').trim() || '.';
    return path.join(base, LOCAL_SAVE_DIRNAME);
}
/**
 * 把内容渲染为保存提示（追加在 outline_search / outline_get_document 结果末尾）。
 * dir 为空表示未配置保存目录 → 提示先配置；否则提示可回复"保存"触发 outline_save_local。
 * 纯函数，可单测。
 */
export function renderLocalSaveHint(dir, kind) {
    if (dir.trim() === '') {
        return `\n\n💾 如需把本次结果存为本地 Markdown 文件，请先在 设置 → 插件 → 插件配置 的「Outline 知识库」卡片中填写本地保存目录。`;
    }
    const what = kind === 'search' ? '本次搜索结果' : '本文档';
    return `\n\n💾 是否将${what}整理成文档存放在本地？如需保存，回复"保存"并给出标题（可选），将存入 ${dir}。`;
}
/** 文件名合法化：替换文件系统非法字符与首尾空白；空串回退为 untitled。 */
export function sanitizeFileName(title) {
    const cleaned = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    return cleaned !== '' ? cleaned : 'untitled';
}
/** 提取当前日期 YYYY-MM-DD（本地时区），供默认文件名前缀。 */
function localDateString(now) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
/** 把文档渲染为 Markdown 正文。 */
export function documentToMarkdown(doc) {
    return `# ${doc.title}\n\n- 来源：${doc.url}\n- 文档 id：${doc.id}\n\n${doc.text}\n`;
}
/** 组装默认文件名：YYYY-MM-DD-<合法化标题>.md */
export function buildSaveFileName(title, now = new Date()) {
    return `${localDateString(now)}-${sanitizeFileName(title)}.md`;
}
/** 冲突时追加序号：name.md → name-2.md → name-3.md …（存在性由传入的 exists 检查，便于测试）。 */
export async function dedupeFileName(dir, fileName, exists) {
    if (!(await exists(path.join(dir, fileName))))
        return fileName;
    const ext = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - ext.length);
    for (let i = 2;; i++) {
        const candidate = `${stem}-${i}${ext}`;
        if (!(await exists(path.join(dir, candidate))))
            return candidate;
    }
}
/** 单次批量保存的文档数上限（防误传全库 id 拖垮 API）。 */
export const SAVE_MAX_DOCS = 50;
/** 把多篇文档合并为一份带目录的 Markdown（目录 → 各篇全文）。 */
export function mergeDocumentsToMarkdown(docs, title) {
    const head = [`# ${title}`, '', `- 导出时间：${new Date().toLocaleString()}`, `- 文档数：${docs.length}`, '', '## 目录', ''];
    docs.forEach((d, i) => head.push(`${i + 1}. [${d.title}](${d.url})`));
    const body = docs.map((d) => `\n\n---\n\n${documentToMarkdown(d)}`).join('');
    return head.join('\n') + body;
}
export function outlineSaveLocalTool(getSaveDir, makeClient) {
    return defineTool({
        name: 'outline_save_local',
        description: '把指定的 Outline 文档（一篇或多篇）整理成 Markdown 文件保存到本地目录（配置的 localSaveDir，默认 $DSH_HOME/outline-auto-saves）。用户在对话中同意保存后调用本工具；批量保存"刚才的搜索结果"时，把各条结果的 id 一起传入 ids。',
        parameters: {
            ids: { type: 'string', required: true, description: `要保存的文档 id，逗号分隔（来自 outline_search 结果，最多 ${SAVE_MAX_DOCS} 篇）` },
            title: { type: 'string', description: '可选，文件标题；默认单篇取文档标题、多篇取"首篇标题等N篇"' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true, description: '写入的本地文件绝对路径' },
                    bytes: { type: 'integer', required: true, description: '写入字节数' },
                    documents: { type: 'integer', required: true, description: '实际合并保存的文档篇数' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `💾 已保存 ${value.documents} 篇文档到本地：${value.path}（${value.bytes} 字节）`,
                }],
        },
        async execute(args) {
            const dir = (getSaveDir() ?? '').trim();
            if (dir === '') {
                throw new Error('本地保存目录未配置。请在 设置 → 插件 → 插件配置 的「Outline 知识库」卡片中填写本地保存目录。');
            }
            const ids = [...new Set((args.ids ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))];
            if (ids.length === 0) {
                throw new Error('请提供至少一个文档 id（参数 ids，逗号分隔，来自 outline_search 结果）。');
            }
            if (ids.length > SAVE_MAX_DOCS) {
                throw new Error(`一次最多保存 ${SAVE_MAX_DOCS} 篇（当前 ${ids.length} 篇），请分批保存。`);
            }
            const client = makeClient();
            // 串行拉取：复用 getDocument 缓存，且对 Outline 限流友好（多篇合并场景 429 退避由 client 处理）。
            const docs = [];
            for (const id of ids) {
                docs.push(await client.getDocument(id));
            }
            const defaultTitle = docs.length === 1 ? docs[0].title : `${docs[0].title}等${docs.length}篇`;
            const title = (args.title ?? '').trim() !== '' ? (args.title ?? '').trim() : defaultTitle;
            const markdown = docs.length === 1 ? documentToMarkdown(docs[0]) : mergeDocumentsToMarkdown(docs, title);
            const fileName = await dedupeFileName(dir, buildSaveFileName(title), async (p) => {
                try {
                    await stat(p);
                    return true;
                }
                catch {
                    return false;
                }
            });
            const filePath = path.join(dir, fileName);
            await mkdir(dir, { recursive: true });
            await writeFile(filePath, markdown, 'utf8');
            return { path: filePath, bytes: Buffer.byteLength(markdown, 'utf8'), documents: docs.length };
        },
    });
}
export function outlineSearchTool(makeClient, defaultLimit, getSaveDir, getSynonyms) {
    return defineTool({
        name: 'outline_search',
        description: '在 Outline 知识库中按关键词搜索文档，返回该关键词的匹配总数、标题、命中片段、文档 id 与链接。可选按集合/作者/更新时间过滤。配置好 token 后即可检索全部文档。',
        parameters: {
            query: { type: 'string', required: true, description: '搜索关键词' },
            limit: { type: 'integer', description: `返回结果条数（默认 ${defaultLimit}，最大 ${SEARCH_MAX_LIMIT}）` },
            collectionId: { type: 'string', description: '可选，限定搜索某个集合（用 outline_list_collections 获取 id）' },
            author: { type: 'string', description: '可选，按作者过滤：姓名或邮箱（先精确后模糊匹配；匹配到多人时返回候选列表，请换 outline_list_users 查 id）' },
            userId: { type: 'string', description: '可选，按作者过滤（用户 id，精确值；可先用 outline_list_users 查询）' },
            updatedAfter: { type: 'string', description: '可选，只返回此时间之后更新的文档（ISO 时间，如 2026-08-01T00:00:00Z 或 2026-08-01）' },
            offset: { type: 'integer', description: '可选，跳过前 N 条结果（配合 limit 翻页查看更多，默认 0）' },
            all: { type: 'boolean', description: '可选，true = 自动翻页抓取该关键词的全部匹配（上限 100 篇，跨页去重）；适合"列全所有相关文档"类需求' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    total: { type: 'integer', required: true, description: '该关键词在知识库中的匹配总数' },
                    hits: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                snippet: { type: 'string', required: true },
                                collectionId: { type: 'string', required: true },
                                updatedAt: { type: 'string', required: true },
                                parentDocumentId: { type: 'string', description: '父文档 id（顶层文档为空）' },
                                authorName: { type: 'string', description: '作者显示名（实例未返回作者或 users.list 不可用时缺省）' },
                            },
                        },
                    },
                    retriedWith: { type: 'string', description: '原词零命中时实际生效的重试词（多词查询首词或同义词表变体）' },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: (value.retriedWith !== undefined ? `（原查询无结果，已用 "${value.retriedWith}" 重试命中）\n` : '')
                        + renderSearchResults(value, args.all === true)
                        + (getSaveDir !== undefined ? renderLocalSaveHint(getSaveDir(), 'search') : ''),
                }],
        },
        async execute(args) {
            const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, args.limit ?? defaultLimit));
            const offset = Math.max(0, args.offset ?? 0);
            const client = makeClient();
            // 作者名 → userId 解析：优先精确/模糊匹配 users.list，下推到 Outline 服务端过滤（比盲搜人肉挑更高效、更省 token）。
            let resolvedUserId = args.userId;
            if (args.author !== undefined && args.author.trim() !== '' && (resolvedUserId === undefined || resolvedUserId.trim() === '')) {
                const matches = await client.findUsers(args.author.trim());
                if (matches.length === 1) {
                    resolvedUserId = matches[0].id;
                }
                else if (matches.length > 1) {
                    const candidates = matches.map((m) => `- ${m.name}（id: ${m.id}${m.email ? `, ${m.email}` : ''}）`).join('\n');
                    throw new Error(`"${args.author}" 匹配到多位作者，请改用 outline_list_users 确认后传入 userId：\n${candidates}`);
                }
                else {
                    throw new Error(`未找到名为 "${args.author}" 的作者（可先用 outline_list_users 查看全部成员）。`);
                }
            }
            const filters = { userId: resolvedUserId, updatedAfter: args.updatedAfter };
            /** 执行一次查询：默认单页；all=true 时抓全（上限 SEARCH_ALL_MAX，跨页按 id 去重）。
             *  抓取策略：① 按服务端单页上限（100）一次抓满 —— 同一实例实测比 4×limit25 串行快约 30%，
             *  且服务端只跑一次检索；返回集合与顺序与逐页串行完全一致。
             *  ② 实例上限更低（返回条数少于请求条数）时，以实际页长为步长并发补齐余下页面。 */
            const runQuery = async (q) => {
                if (args.all !== true) {
                    return client.searchDocuments(q, limit, args.collectionId, filters, offset);
                }
                const hits = [];
                const seen = new Set();
                let total = 0;
                /** 吸收一页结果：返回该页新增（未见过）条数。 */
                const absorb = (r) => {
                    total = r.total;
                    let fresh = 0;
                    for (const h of r.hits) {
                        if (!seen.has(h.id)) {
                            seen.add(h.id);
                            hits.push(h);
                            fresh += 1;
                        }
                    }
                    return fresh;
                };
                const done = () => hits.length >= total || hits.length >= SEARCH_ALL_MAX;
                // ① 一次抓满（limit 取「服务端上限」与「本工具总上限」的较小值）
                const want = Math.min(SEARCH_ALL_MAX, OUTLINE_MAX_PAGE_SIZE);
                const first = await client.searchDocuments(q, want, args.collectionId, filters, 0);
                absorb(first);
                if (first.hits.length === 0 || done())
                    return { total, hits: hits.slice(0, SEARCH_ALL_MAX) };
                // ② 兜底：服务端把 limit 压小（短页）时，先顺序探测下一页确认 offset 真的生效
                //    （部分实例无视 offset 每次都返回同一页），确认后再并发补齐余下页面。
                const step = first.hits.length;
                const second = await client.searchDocuments(q, step, args.collectionId, filters, step);
                if (second.hits.length === 0 || absorb(second) === 0 || done())
                    return { total, hits: hits.slice(0, SEARCH_ALL_MAX) };
                const offsets = [];
                for (let off = step * 2; off < SEARCH_ALL_MAX && off < Math.min(total, SEARCH_ALL_MAX); off += step)
                    offsets.push(off);
                if (offsets.length > 0) {
                    const rest = await mapWithConcurrency(offsets, SEARCH_ALL_CONCURRENCY, (off) => client.searchDocuments(q, step, args.collectionId, filters, off));
                    for (const r of rest) {
                        if (r.hits.length === 0)
                            continue;
                        absorb(r);
                    }
                }
                return { total, hits: hits.slice(0, SEARCH_ALL_MAX) };
            };
            let result = await runQuery(args.query);
            let effectiveQuery = args.query;
            // 零命中回退阶梯：原词 → 首词（多词查询易 AND 落空）→ 同义词表变体（配置 synonyms）。
            if (result.hits.length === 0 && result.total === 0) {
                const terms = args.query.trim().split(/\s+/);
                const attempts = [];
                if (terms.length > 1 && terms[0] !== undefined && terms[0] !== '')
                    attempts.push(terms[0]);
                if (getSynonyms !== undefined)
                    attempts.push(...synonymVariants(args.query, getSynonyms()));
                for (const attempt of attempts.filter((v, i) => attempts.indexOf(v) === i)) {
                    const retried = await runQuery(attempt);
                    if (retried.hits.length > 0) {
                        result = { ...retried, retriedWith: attempt };
                        effectiveQuery = attempt;
                        break;
                    }
                }
            }
            // 本地重排：标题命中优先于摘要命中 + 新近度加成（同分保持服务端原序）。
            return { ...result, hits: rerankHits(result.hits, effectiveQuery) };
        },
    });
}
export function outlineListUsersTool(makeClient) {
    return defineTool({
        name: 'outline_list_users',
        description: '列出 Outline 工作区用户（id/姓名/邮箱），用于把"某人写的文档"中的姓名解析成 outline_search 的 author/userId 参数。',
        parameters: {},
        output: {
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        email: { type: 'string', description: '邮箱（实例未返回时缺省）' },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.length === 0
                        ? '当前 token 可见范围内没有用户。'
                        : `用户（${value.length} 个）：\n` + value.map((u) => `- ${u.name}（id: ${u.id}${u.email ? `, ${u.email}` : ''}）`).join('\n'),
                }],
        },
        async execute() {
            return makeClient().listUsers();
        },
    });
}
export function outlineCountTool(makeClient) {
    return defineTool({
        name: 'outline_count',
        description: '统计 Outline 知识库文档总数（documents.list 分页 total，精确值；不含已删除/回收站文档，若计入则实际总数可能略多）。用于回答"知识库有多少文档 / 多大"等问题；若要检索具体文档请用 outline_search。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    total: { type: 'integer', required: true, description: 'Outline 知识库文档总数（不含已删除/回收站文档）' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Outline 知识库当前可访问文档总数：${value.total} 篇。` }],
        },
        async execute() {
            return { total: await makeClient().countDocuments() };
        },
    });
}
export function outlineGetDocumentTool(makeClient, getSaveDir) {
    return defineTool({
        name: 'outline_get_document',
        description: '按文档 id（来自 outline_search 的结果或 Outline 的 urlId）获取文档完整内容（Markdown 格式）。',
        parameters: {
            id: { type: 'string', required: true, description: '文档 UUID 或 urlId' },
            maxLength: { type: 'integer', description: '返回内容最大字符数（默认 20000，最小 1000，最大 200000），超出截断' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    updatedAt: { type: 'string', required: true },
                    collectionId: { type: 'string', description: '所属集合 id' },
                    parentDocumentId: { type: 'string', description: '父文档 id（顶层文档为空）' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: renderDocument(value, value.truncated) + (getSaveDir !== undefined ? renderLocalSaveHint(getSaveDir(), 'document') : ''),
                }],
        },
        async execute(args) {
            const maxLength = Math.min(DOCUMENT_MAX_LENGTH_CAP, Math.max(1000, args.maxLength ?? DOCUMENT_DEFAULT_MAX_LENGTH));
            const doc = await makeClient().getDocument(args.id);
            const truncated = doc.text.length > maxLength;
            return { ...doc, text: truncated ? doc.text.slice(0, maxLength) : doc.text, truncated };
        },
    });
}
/** 审批提示文案：完整路径 + 标题 + 内容预览（前 100 字，纯函数可单测）。 */
export function buildCreateApprovalReason(args, collectionName, resolvedPath) {
    const location = resolvedPath !== undefined && resolvedPath.length > 0
        ? `路径：${resolvedPath.join(' / ')}`
        : `集合「${collectionName && collectionName !== '' ? collectionName : (args.collectionId ?? '未知集合')}」`;
    const preview = (args.text ?? '').replace(/\s+/g, ' ').slice(0, 100);
    return `在以下位置创建 Outline 文档：\n${location}\n标题：「${args.title ?? '(无标题)'}」\n内容预览：${preview}${(args.text ?? '').length > 100 ? '…' : ''}`;
}
/** 解析可写目录配置（逗号分隔）：`集合名` 或 `集合名/目录A/子目录B`。 */
export function parseWritablePaths(raw) {
    return raw.split(',').map((x) => x.trim()).filter((x) => x !== '').map((path) => {
        const segments = path.split('/').map((s) => s.trim()).filter((s) => s !== '');
        const collectionName = segments.shift() ?? '';
        return { collectionName, segments };
    });
}
/**
 * 目录级写入守卫：目标路径必须落在白名单条目内（前缀匹配，fail-closed）。
 * - 白名单为空 → 拒绝（插件为只读模式）
 * - 目标路径解析失败（集合/文档不可见）→ 拒绝
 * - 条目 `集合A/目录1` 匹配 `[集合A, 目录1, …任意子级]`；`集合A` 匹配整个集合
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export async function resolvePathGuard(client, target, entries, collections) {
    if (entries.length === 0) {
        return '插件当前为只读模式：未配置可写目录。请在 设置 → 插件 → 插件配置 中填写可写目录（逗号分隔，如 集合A,集合B/目录1）。';
    }
    let targetPath;
    try {
        if (target.kind === 'create') {
            const coll = collections.find((c) => c.id === target.collectionId.trim());
            if (coll === undefined) {
                return `无法确认写入目标集合（${target.collectionId}）：集合不存在或当前 token 无权查看。为避免误写，本次操作已拒绝。`;
            }
            targetPath = target.parentDocumentId !== undefined && target.parentDocumentId !== ''
                ? await client.resolveDocumentPath(target.parentDocumentId)
                : [coll.name];
        }
        else {
            targetPath = await client.resolveDocumentPath(target.docId);
        }
    }
    catch {
        return '无法解析写入目标路径：目标集合或文档不可见。为避免误写，本次操作已拒绝。';
    }
    if (targetPath.length === 0)
        return '无法解析写入目标路径：目标位置为空。为避免误写，本次操作已拒绝。';
    const collectionName = targetPath[0];
    const rest = targetPath.slice(1);
    const matched = entries.some((e) => {
        if (normalizeName(e.collectionName) !== normalizeName(collectionName))
            return false;
        if (e.segments.length > rest.length)
            return false;
        return e.segments.every((seg, i) => normalizeName(seg) === normalizeName(rest[i]));
    });
    if (!matched) {
        const allowed = entries.map((e) => e.segments.length === 0 ? e.collectionName : `${e.collectionName}/${e.segments.join('/')}`).join('、');
        return `禁止写入「${targetPath.join(' / ')}」：目标不在可写目录内。已配置可写目录：${allowed}。如需写入，请在 设置 → 插件 → 插件配置 中添加该路径。`;
    }
    return null;
}
/** 标准需求文档模板（Markdown）。
 * 排版约定：条目类章节（需求或目标/交付物/交付标准/潜在风险点/工作思路）如有多个条目，
 * 必须换行并逐条编号（1、2、3、… 一点一行），不要挤成一段。 */
export const REQUIREMENT_DOC_TEMPLATE = [
    '# <标题>-需求文档',
    '',
    '【需求或目标】：<一句话概括核心目标；如有多个目标，逐条列出>',
    '1、<目标 1>',
    '2、<目标 2>',
    '',
    '【交付物】：<如有多个交付物，一点一行，罗列清晰>',
    '1、<交付物 1>',
    '2、<交付物 2>',
    '3、<交付物 3>',
    '',
    '【交付标准】：<做成什么样算好；多条标准逐条列出>',
    '1、<标准 1>',
    '2、<标准 2>',
    '',
    '【交付时间】：<具体时间，如 YYYY-MM-DD 或 今日 14:30 前>',
    '',
    '【潜在风险点】：<哪里可能卡住；多个风险逐条列出>',
    '1、<风险 1>',
    '2、<风险 2>',
    '',
    '【解决的问题】：<具体帮谁，解决了什么问题；多个逐条列出>',
    '1、<问题 1>',
    '',
    '【工作思路】：<分步骤，一步一行>',
    '1. <第一步>',
    '2. <第二步>',
    '3. <第三步>',
    '',
    '【备注】：<可写可不写，如参考文档链接、工具访问地址、账号权限说明>',
    '',
    '### 当前状态：待交付',
    '',
].join('\n');
/** 模板的章节清单（供 AI 核对是否写全）。 */
export const REQUIREMENT_DOC_SECTIONS = ['需求或目标', '交付物', '交付标准', '交付时间', '潜在风险点', '解决的问题', '工作思路', '备注', '当前状态'];
export function outlineDocTemplateTool() {
    return defineTool({
        name: 'outline_doc_template',
        description: '返回标准的需求文档模板（Markdown）与章节清单。撰写/更新需求文档前先调用本工具获取模板，保证格式一致。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    template: { type: 'string', required: true, description: '需求文档标准模板（Markdown）' },
                    sections: { type: 'array', required: true, items: { type: 'string' }, description: '必须包含的章节清单' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `需求文档标准模板（章节：${value.sections.join(' / ')}）：\n\n${value.template}`,
                }],
        },
        async execute() {
            return { template: REQUIREMENT_DOC_TEMPLATE, sections: [...REQUIREMENT_DOC_SECTIONS] };
        },
    });
}
/** Outline 权限中允许文档写入的值。未知权限按只读处理，避免兼容层误放行。 */
const WRITE_PERMISSIONS = new Set(['read_write', 'manage', 'admin']);
/**
 * 基础写入守卫：必须确认集合存在且 token 有写权限。
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export function resolveWriteGuard(collections, collectionId) {
    const normalizedId = collectionId.trim();
    if (normalizedId === '')
        return '无法确认写入目标：缺少 collectionId。请先使用 outline_list_collections 或 outline_resolve_path。';
    const collection = collections.find((c) => c.id === normalizedId);
    if (collection === undefined) {
        return `无法确认写入目标集合（${normalizedId}）：集合列表不可用、集合不存在，或当前 token 无权查看。为避免误写，本次操作已拒绝。`;
    }
    const name = collection.name.trim();
    const permission = collection.permission.trim().toLowerCase();
    if (!WRITE_PERMISSIONS.has(permission)) {
        return `禁止在集合「${name || normalizedId}」写入文档：当前 token 的集合权限为「${collection.permission || '未知'}」。`;
    }
    return null;
}
/** 名称归一化：小写并去掉破折号/空格/下划线/括号，容忍"张三"与"张-三"这类差异。 */
function normalizeName(name) {
    return name.toLowerCase().replace(/[-_·\s（）()]/g, '');
}
/** 在候选中按名称匹配：先精确（归一化后），再包含匹配；多个命中返回 null 并给出候选。 */
function matchName(candidates, wanted) {
    const target = normalizeName(wanted);
    const exact = candidates.filter((c) => normalizeName(c.name) === target);
    if (exact.length === 1)
        return exact[0];
    const partial = candidates.filter((c) => normalizeName(c.name).includes(target));
    if (partial.length === 1)
        return partial[0];
    return null;
}
export function outlineResolvePathTool(makeClient) {
    return defineTool({
        name: 'outline_resolve_path',
        description: '把用户描述的知识库路径（如"集合A/目录1/子目录2"）解析为具体的 collectionId 与 parentDocumentId，并返回解析出的完整路径。用于定位"在某某目录下创建文档"的目标位置；解析成功后把返回的 id 传给 outline_create（创建前用户还会看到完整路径确认）。',
        parameters: {
            path: { type: 'string', required: true, description: '路径，用 / 分隔：第一段是集合名，后续段是逐级目录（文档）名，如 集合A/目录1/子目录2' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    collectionId: { type: 'string', required: true },
                    parentDocumentId: { type: 'string' },
                    path: {
                        type: 'array',
                        required: true,
                        items: { type: 'string' },
                        description: '解析出的完整路径段（自顶向下）',
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.parentDocumentId !== undefined && value.parentDocumentId !== null && value.parentDocumentId !== ''
                        ? `已定位：${value.path.join(' / ')}\ncollectionId=${value.collectionId}\nparentDocumentId=${value.parentDocumentId}`
                        : `已定位：${value.path.join(' / ')}（集合根级）\ncollectionId=${value.collectionId}`,
                }],
        },
        async execute(args) {
            const client = makeClient();
            const segments = args.path.split('/').map((s) => s.trim()).filter((s) => s !== '');
            if (segments.length === 0)
                throw new Error('路径不能为空，格式：集合名/目录1/目录2/...');
            // 第一段：集合
            const collections = await client.listCollections();
            const coll = matchName(collections, segments[0]);
            if (coll === null) {
                throw new Error(`找不到集合「${segments[0]}」。可见集合：${collections.map((c) => c.name).join('、')}`);
            }
            // 后续段：逐级定位子文档（目录）
            // 根层级用集合内搜索（顶层目录名通常较短）；更深层级用 documents.list 拉全量子文档本地匹配（避免搜索分词歧义）。
            const resolvedNames = [coll.name];
            let parentId;
            for (const seg of segments.slice(1)) {
                let candidates;
                if (parentId === undefined) {
                    const { hits } = await client.searchDocuments(seg, 25, coll.id);
                    candidates = hits
                        .filter((h) => h.parentDocumentId === undefined || h.parentDocumentId === null || h.parentDocumentId === '')
                        .map((h) => ({ id: h.id, name: h.title }));
                }
                else {
                    candidates = (await client.listChildDocuments(parentId)).map((h) => ({ id: h.id, name: h.title }));
                }
                const matched = matchName(candidates, seg);
                if (matched === null) {
                    const available = candidates.length > 0 ? `候选：${candidates.map((c) => c.name).join('、')}` : '该层级没有匹配的子文档';
                    throw new Error(`在「${resolvedNames.join(' / ')}」下找不到「${seg}」。${available}`);
                }
                parentId = matched.id;
                resolvedNames.push(matched.name);
            }
            return {
                collectionId: coll.id,
                ...(parentId !== undefined ? { parentDocumentId: parentId } : {}),
                path: resolvedNames,
            };
        },
    });
}
export function outlineListCollectionsTool(makeClient) {
    return defineTool({
        name: 'outline_list_collections',
        description: '列出当前 token 可见的 Outline 集合（id、名称、权限、文档数），用于确定 outline_create 的目标集合。',
        parameters: {},
        output: {
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        permission: { type: 'string', required: true },
                        documentCount: { type: 'integer', description: '文档数（部分实例可能不返回）' },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.length === 0
                        ? '当前 token 没有可见集合。'
                        : `可见集合（${value.length} 个）：\n` + value.map((c) => `- ${c.name}（${c.id}，${c.permission}${typeof c.documentCount === 'number' ? `，文档 ${c.documentCount} 篇` : ''}）`).join('\n'),
                }],
        },
        async execute() {
            return makeClient().listCollections();
        },
    });
}
export function outlineCreateTool(makeClient, getWritablePaths) {
    return defineTool({
        name: 'outline_create',
        description: '在指定 Outline 集合创建文档（写操作，每次执行前需用户审批，审批展示解析后的完整路径）。创建后返回文档链接。请先用 outline_list_collections / outline_resolve_path 确认目标位置。',
        parameters: {
            collectionId: { type: 'string', required: true, description: '目标集合 id（用 outline_list_collections 获取）' },
            parentDocumentId: { type: 'string', description: '可选，父文档 id（嵌套目录）；不填则创建在集合根级' },
            title: { type: 'string', required: true, description: '文档标题' },
            text: { type: 'string', required: true, description: 'Markdown 正文' },
            publish: { type: 'boolean', description: '默认 true（创建即发布）；false = 存草稿（仅作者可见）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    published: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.published
                        ? `✅ 已创建并发布文档：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`
                        : `📝 已创建草稿（未发布）：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`,
                }],
        },
        async execute(args) {
            const client = makeClient();
            const collections = await client.listCollections();
            // 写入守卫（防御纵深，即使绕过审批直调也会被拦）：目录白名单 → 集合存在与权限
            const pathGuard = await resolvePathGuard(client, { kind: 'create', collectionId: args.collectionId, parentDocumentId: args.parentDocumentId }, parseWritablePaths(getWritablePaths()), collections);
            if (pathGuard !== null)
                throw new Error(pathGuard);
            const guard = resolveWriteGuard(collections, args.collectionId);
            if (guard !== null)
                throw new Error(guard);
            return client.createDocument({
                collectionId: args.collectionId,
                parentDocumentId: args.parentDocumentId,
                title: args.title,
                text: args.text,
                publish: args.publish,
            });
        },
    });
}
export function outlineUpdateDocumentTool(makeClient, getWritablePaths) {
    return defineTool({
        name: 'outline_update_document',
        description: '更新已有 Outline 文档的标题/正文（写操作，执行前需用户审批，审批展示文档完整路径）。',
        parameters: {
            id: { type: 'string', required: true, description: '文档 id（来自 outline_search / outline_get_document）' },
            title: { type: 'string', description: '可选，新标题' },
            text: { type: 'string', description: '可选，新 Markdown 正文' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    published: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `✏️ 已更新文档：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}` }],
        },
        async execute(args) {
            // 参数校验：pre-execute 钩子会拦截；此处做 fail-closed 兜底（防止绕过审批直调时静默成功）
            if ((args.title === undefined || args.title === '') && (args.text === undefined || args.text === '')) {
                throw new Error('outline_update_document 至少需要 title 或 text 之一');
            }
            const client = makeClient();
            const doc = await client.getDocument(args.id);
            const collections = await client.listCollections();
            const pathGuard = await resolvePathGuard(client, { kind: 'doc', docId: args.id }, parseWritablePaths(getWritablePaths()), collections);
            if (pathGuard !== null)
                throw new Error(pathGuard);
            const guard = resolveWriteGuard(collections, doc.collectionId ?? '');
            if (guard !== null)
                throw new Error(guard);
            return client.updateDocument(args.id, { title: args.title, text: args.text });
        },
    });
}
export function outlineDeleteTool(makeClient, getWritablePaths, requestApproval) {
    return defineTool({
        name: 'outline_delete',
        description: '删除 Outline 文档（**不可恢复**，双重审批：第一道在调用时弹窗，第二道在删除执行前再次确认）。',
        parameters: {
            id: { type: 'string', required: true, description: '文档 id（来自 outline_search / outline_get_document）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    success: { type: 'boolean', required: true },
                    id: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `🗑 已删除文档（${value.id}）` }],
        },
        async execute(args, exec) {
            const client = makeClient();
            const doc = await client.getDocument(args.id);
            const collections = await client.listCollections();
            const pathGuard = await resolvePathGuard(client, { kind: 'doc', docId: args.id }, parseWritablePaths(getWritablePaths()), collections);
            if (pathGuard !== null)
                throw new Error(pathGuard);
            const guard = resolveWriteGuard(collections, doc.collectionId ?? '');
            if (guard !== null)
                throw new Error(guard);
            // 第二道审批（第一道在 pre-execute 钩子）；暂停等待用户点同意
            const ok = await requestApproval(`再次确认删除文档（不可恢复）：\n路径：${(await client.resolveDocumentPath(args.id)).join(' / ')}\n标题：「${doc.title}」`, exec);
            if (!ok)
                throw new Error('删除已被用户取消（第二道确认未通过）。');
            const result = await client.deleteDocument(args.id);
            return { success: result.success, id: args.id };
        },
    });
}
export function outlineListChildrenTool(makeClient) {
    return defineTool({
        name: 'outline_list_children',
        description: '列出某目录（父文档）下的直接子文档，用于浏览知识库目录结构。',
        parameters: {
            parentId: { type: 'string', required: true, description: '父文档 id（目录）' },
        },
        output: {
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true },
                        title: { type: 'string', required: true },
                        url: { type: 'string', required: true },
                        snippet: { type: 'string', description: '摘要片段（列表接口通常为空）' },
                        collectionId: { type: 'string', required: true },
                        updatedAt: { type: 'string', required: true },
                        parentDocumentId: { type: 'string', description: '父文档 id' },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.length === 0
                        ? '该目录下没有子文档。'
                        : `子文档（${value.length} 个）：\n` + value.map((d) => `- [${escapeLinkText(d.title)}](${wrapUrl(d.url)})`).join('\n'),
                }],
        },
        async execute(args) {
            return makeClient().listChildDocuments(args.parentId);
        },
    });
}
