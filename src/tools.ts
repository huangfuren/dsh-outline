import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mapWithConcurrency, OUTLINE_MAX_PAGE_SIZE } from './client.js'
import type { OutlineClient, OutlineSearchResult, OutlineSearchHit, OutlineDocument, OutlineCollection, OutlineCreateResult, OutlineUser } from './client.js'

export const SEARCH_MAX_LIMIT = 25
/** all=true 时自动翻页的总条数上限（防超大结果集撑爆上下文）。 */
export const SEARCH_ALL_MAX = 100
/**
 * all=true 且实例只能在本地按时间筛选（Outline 1.12 之前）时的**扫描**上限。
 *
 * 本地筛选会筛掉大部分候选，扫 100 篇往往只剩个位数命中；窗口放宽到 3 倍换取更多命中，
 * 返回条数仍受 SEARCH_ALL_MAX 约束（上下文成本由命中数决定，不由扫描量决定）。
 */
export const SEARCH_ALL_SCAN_MAX = 300
/** all=true 翻页时同时在飞的请求数上限（前两页顺序探测，余下页面并发）。 */
export const SEARCH_ALL_CONCURRENCY = 4
export const DOCUMENT_DEFAULT_MAX_LENGTH = 20000
export const DOCUMENT_MAX_LENGTH_CAP = 200000

/** 转义链接文字里的 Markdown 特殊字符，避免标题含 []() 时破坏 [title](url) 链接。 */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (ch) => (ch === '\\' ? '\\\\' : '\\' + ch))
}

/** URL 含空格或括号时用 <> 包裹，保证 markdown 链接闭合正确。 */
function wrapUrl(url: string): string {
  return /[\s()]/.test(url) ? `<${url}>` : url
}

/**
 * 本地轻量重排：Outline 服务端只按关键词相关度排序，这里补两点——
 * 标题命中权重高于摘要命中；一年内更新的文档有新近度加成（2 分随年龄递减到 0）。
 * 纯函数、稳定排序（同分保持服务端原序）、可单测；命中 ≤1 时原样返回。
 */
export function rerankHits(hits: OutlineSearchHit[], query: string): OutlineSearchHit[] {
  if (hits.length <= 1) return hits
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '')
  if (terms.length === 0) return hits
  const now = Date.now()
  const scored = hits.map((hit, index) => {
    let score = 0
    const title = hit.title.toLowerCase()
    const snippet = hit.snippet.toLowerCase()
    for (const term of terms) {
      if (title.includes(term)) score += 10
      if (snippet.includes(term)) score += 4
    }
    const updated = Date.parse(hit.updatedAt)
    if (!Number.isNaN(updated)) {
      const ageDays = Math.max(0, (now - updated) / 86_400_000)
      score += Math.max(0, 2 - ageDays / 365)
    }
    return { hit, score, index }
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((entry) => entry.hit)
}

/** 同义词回退候选：整词命中词表优先，其次逐词替换；去重、排除原词、上限 3 个变体。 */
export function synonymVariants(query: string, synonyms: Record<string, string[]>): string[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const terms = trimmed.split(/\s+/)
  const out: string[] = []
  const push = (value: string) => {
    const v = value.trim()
    if (v !== '' && v !== trimmed && !out.includes(v)) out.push(v)
  }
  for (const alt of synonyms[trimmed] ?? []) push(alt)
  for (const term of terms) {
    for (const alt of synonyms[term] ?? []) {
      // 多词查询：替换其中一个词生成新查询（"部署 规范" 且 部署→上线 → "上线 规范"）
      if (terms.length > 1) push(terms.map((t) => (t === term ? alt : t)).join(' '))
      else push(alt)
    }
  }
  return out.slice(0, 3)
}

// 入参用结构类型而非 OutlineSearchResult：output schema 里 timeFilterMode 声明为 string，
// 与 client 侧的 'server' | 'client' 字面量联合不完全同构，这里只需按值比较，不必收窄。
function renderSearchResults(
  result: { total: number; hits: OutlineSearchHit[]; timeFilterMode?: string; scannedCount?: number },
  allMode = false,
): string {
  const { total, hits, timeFilterMode, scannedCount } = result
  // 老实例没有服务端时间过滤：这一页是过滤前的结果，本地筛选后可能为空，
  // 而 total 仍是过滤前总数。
  const clientFiltered = timeFilterMode === 'client'
  const scanned = scannedCount ?? hits.length
  const lines = hits.map((hit) => {
    const meta = hit.snippet.length > 0 ? ` — ${hit.snippet}` : ''
    const author = hit.authorName !== undefined && hit.authorName !== '' ? `（作者：${hit.authorName}）` : ''
    return `- [${escapeLinkText(hit.title)}](${wrapUrl(hit.url)})${meta}（id: ${hit.id}）${author}`
  })
  const footer = '\n\n如需查看某篇全文，请使用 outline_get_document 工具（参数 id）。'

  // 本地筛选分支单独渲染：total 是「时间过滤之前的全库匹配数」，拿它算「还有 N 篇未显示」
  // 会把时间范围之外的文档说成待翻页结果（用户以为还能翻出更多近期文档，实际全是旧的）。
  // 这里只报能确证的数字：实际扫描的候选量、命中的条数。
  if (clientFiltered) {
    const scope = allMode ? '（候选范围内尽量取全）' : '（单页）'
    const note = '\n\n⚠️ 此实例不支持服务端时间过滤（Outline 1.12 之前没有 filters 参数），'
      + `只能在已取回的候选里按更新时间本地筛选，命中可能不全；`
      + `${total} 是该关键词的全库匹配数，未按时间过滤。要覆盖更全请去掉时间条件，或让管理员把 Outline 升级到 1.12+。`
    if (hits.length === 0) {
      return `已扫描 ${scanned} 篇候选${scope}，其中没有在指定时间之后更新的文档。` + note
    }
    return `已扫描 ${scanned} 篇候选${scope}，其中 ${hits.length} 篇在指定时间之后更新：\n${lines.join('\n')}${note}${footer}`
  }

  if (hits.length === 0) {
    return (total > 0 ? `该关键词共匹配 ${total} 篇文档，但未返回可展示的结果。` : '未找到匹配文档，可尝试更换关键词（如去掉停用词、改用更短的词）。') + footer
  }
  const fetchedAll = allMode && hits.length >= total
  const head = fetchedAll
    ? `已抓全部 ${hits.length} 篇（关键词共匹配 ${total} 篇）：`
    : `找到 ${hits.length} 篇文档${total > hits.length ? `（关键词共匹配 ${total} 篇，显示前 ${hits.length} 篇）` : ''}：`
  // 仍有更多可翻页时，提示用户如何让 AI 翻页（Outline 不支持 offset 时该提示会引导走 all 模式重抓）。
  const tail = (!fetchedAll && total > hits.length)
    ? `\n\n（还有 ${total - hits.length} 篇未显示。回复"查看下一页"或"全部"可让 AI 用 outline_search 的 offset / all 参数继续获取。）`
    : ''
  return `${head}\n${lines.join('\n')}${tail}${footer}`
}

function renderDocument(doc: OutlineDocument, truncated: boolean): string {
  // 截断提示必须直接点明"不要写回"：text 是整体替换，把截断结果原样交给
  // outline_update_document 会永久丢掉被截掉的部分（读→改→写链路的静默丢内容路径）。
  const note = truncated
    ? `\n\n…（内容已截断：本次只返回前 ${doc.text.length} 字符，全文更长。`
      + '\n⚠️ 不要把本结果直接交给 outline_update_document 写回 —— 它的 text 是**整体替换**，写回会永久丢掉未返回的部分。'
      + '\n如需改全文：先用更大的 maxLength（上限 200000）重新调用 outline_get_document；'
      + '\n如只需追加内容：用 outline_update_document 并传 append: true。）'
    : ''
  return `# ${doc.title}\n\n${doc.url}\n\n${doc.text}${note}`
}

// ---------------------------------------------------------------------------
// 本地保存（localSaveDir + outline_save_local）
// ---------------------------------------------------------------------------

/** 本地保存默认目录名（相对 DSH 主目录；DSH 主目录不可得时回退到用户主目录）。 */
export const LOCAL_SAVE_DIRNAME = 'outline-auto-saves'

/** 解析本地保存目录：配置优先，其次 $DSH_HOME/outline-auto-saves，最后 $HOME/outline-auto-saves。 */
export function resolveLocalSaveDir(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const cfg = (configured ?? '').trim()
  if (cfg !== '') return cfg
  const dshHome = (env.DSH_HOME ?? '').trim()
  const base = dshHome !== '' ? dshHome : (env.USERPROFILE ?? env.HOME ?? '.').trim() || '.'
  return path.join(base, LOCAL_SAVE_DIRNAME)
}

/**
 * 本地保存的安全兜底：这些目录（及其子目录）一律不写，避免把知识库导出物丢进系统目录。
 * 刻意**不带盘符**：判定时先剥掉 `C:` / `D:` 再比对，因此 Windows 装在非 C 盘时同样生效
 * （带盘符的列表在 `D:\Windows` 这类布局下会整体失效）。
 */
export const UNSAFE_SAVE_DIR_ROOTS: readonly string[] = [
  '/windows',
  '/program files',
  '/program files (x86)',
  '/programdata',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/system',
  '/library',
]

/**
 * 折叠路径中的 `.` / `..` / 重复斜杠，返回规范形态（保留盘符与 UNC 前缀）。
 * 目的：判定必须在**折叠之后**进行。纯文本比对会被 `D:/saves/../..` 绕过 ——
 * 字面不以盘根结尾，但随后的 `path.join` 由内核解析 `..`，实际落盘到盘根。
 */
function collapsePathSegments(input: string): string {
  const unc = input.startsWith('//')
  const drive = unc ? '' : (/^[a-zA-Z]:/.exec(input)?.[0] ?? '')
  const body = input.slice(unc ? 2 : drive.length).replace(/^\/+/, '')
  const out: string[] = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  const prefix = unc ? '//' : drive !== '' ? `${drive}/` : '/'
  return prefix + out.join('/')
}

/**
 * `outline_save_local` 的落盘目录校验。**这是安全带，不是沙箱** —— 目录本身由用户配置，
 * 只有目录不可信时才有意义；真正的边界仍是"文件系统权限"。
 * 拒绝三类目标：① 磁盘/文件系统/共享根目录（写入范围会失控）；② 已知系统目录（盘符无关）。
 * 判定对象是**折叠 `..` 之后的规范路径**，因此带 `..` 的写法绕不过去。
 * @returns 拒绝理由；可写时返回 null。
 */
export function checkSaveDir(dir: string): string | null {
  const trimmed = (dir ?? '').trim()
  if (trimmed === '') return null
  const collapsed = collapsePathSegments(trimmed.replace(/\\+/g, '/'))
  const bare = collapsed.replace(/\/+$/, '')
  if (/^[a-z]:$/i.test(bare)) {
    return `拒绝写入磁盘根目录：${dir}。请在 设置 → 插件 → 插件配置 中指定一个子目录（如 D:/outline-saves）。`
  }
  if (bare === '') {
    return `拒绝写入文件系统根目录：${dir}。请指定一个子目录。`
  }
  if (/^\/\/[^/]+\/?[^/]*$/.test(bare)) {
    return `拒绝写入网络共享根目录：${dir}。请指定共享下的子目录。`
  }
  // 系统目录：剥掉盘符后比对，使非 C 盘的系统目录同样被挡
  const lower = bare.toLowerCase().replace(/^[a-z]:/, '')
  for (const root of UNSAFE_SAVE_DIR_ROOTS) {
    if (lower === root || lower.startsWith(root + '/')) {
      return `拒绝写入系统目录：${dir}。请改为用户目录下的子目录（如 D:/outline-saves）。`
    }
  }
  return null
}

/**
 * 根据平台调整文件名长度（Windows MAX_PATH=260 字符硬限）。
 * @returns 截断后的文件名（保留.md 后缀）
 */
export function capFileNameLength(dir: string, fileName: string): string {
  const isWindows = process.platform === 'win32'
  if (!isWindows) return fileName
  
  // Windows MAX_PATH: total path <= 260 chars; leave more headroom for trailing NUL + dedupe
  const maxTotal = 235
  const currentTotal = path.join(dir, fileName).length
  if (currentTotal <= maxTotal) return fileName
  
  const ext = path.extname(fileName)
  const nameWithoutExt = fileName.slice(0, -ext.length)
  const allowedNameLen = Math.max(10, maxTotal - ext.length - dir.length - 5)
  
  if (nameWithoutExt.length <= allowedNameLen) return fileName
  
  return nameWithoutExt.slice(0, allowedNameLen) + ext
}

/**
 * 把文件系统错误翻译为可操作提示（Windows/macOS 区分）。
 */
export function formatFsError(err: unknown, filePath: string): string {
  const isWin = process.platform === 'win32'
  const e = err as NodeJS.ErrnoException
  const code = e.code || 'UNKNOWN'
  
  const hints: Record<string, string> = {
    ENOENT: isWin
      ? `目标目录不存在或路径过长（Windows MAX_PATH 限 260 字符）。请检查配置：「设置 → 插件 → 插件配置」的「本地保存目录」是否为有效短路径？`
      : `目录不存在：请确认路径正确且当前用户有访问权限。`,
    EACCES: isWin
      ? `无写入权限。${filePath} 可能属于管理员目录，请改用用户可写路径（如 C:\\Users\\<你的用户名>\\...）。`
      : `无写入权限。macOS 可能因沙盒限制，请确认该路径在您的用户目录下（~/...）。`,
    EPERM: `操作被系统策略阻止（可能是文件保护/权限限制）。`,
    ENOSPC: `磁盘空间不足，无法写入。`,
    EDQUOT: `配额用尽（NAS/云盘常见）。`,
    EROFS: `目标路径只读，无法创建文件。`,
  }
  
  const hint = hints[code] || e.message || '未知错误'
  return `${hint}\n\n（系统错误码：${code}，路径：${filePath}）`
}

/**
 * 把内容渲染为保存提示（追加在 outline_search / outline_get_document 结果末尾）。
 * dir 为空表示未配置保存目录 → 提示先配置；否则提示可回复"保存"触发 outline_save_local。
 * 纯函数，可单测。
 */
export function renderLocalSaveHint(dir: string, kind: 'search' | 'document'): string {
  if (dir.trim() === '') {
    return `\n\n💾 如需把本次结果存为本地 Markdown 文件，请先在 设置 → 插件 → 插件配置 的「Outline 知识库」卡片中填写本地保存目录。`
  }
  const what = kind === 'search' ? '本次搜索结果' : '本文档'
  return `\n\n💾 是否将${what}整理成文档存放在本地？如需保存，回复"保存"并给出标题（可选），将存入 ${dir}。`
}

/** 文件名合法化：替换文件系统非法字符与首尾空白；空串回退为 untitled。对 Windows 保留设备名也进行保护（CON/NUL/PRN/COM1-9/LPT1-9）。 */
export function sanitizeFileName(title: string): string {
  // 首先清理控制字符和非法字符
  let cleaned = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  
  // 处理前导点、尾随点和空格 → Windows 会静默剪除，但会导致我们的文件名与实际不符
  cleaned = cleaned.replace(/^\.+/, '').replace(/\.+$/, '').replace(/\s+$/, '')
  
  if (cleaned === '') return 'untitled'
  
  // Windows 保留设备名防护（不带扩展名的完整名称）
  // https://learn.microsoft.com/windows/win32/fileio/naming-a-file
  const reservedWindowsNames = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  if (reservedWindowsNames.test(cleaned)) {
    return cleaned + '_'
  }
  
  return cleaned
}

/** 提取当前日期 YYYY-MM-DD（本地时区），供默认文件名前缀。 */
function localDateString(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 把文档渲染为 Markdown 正文。 */
export function documentToMarkdown(doc: OutlineDocument): string {
  return `# ${doc.title}\n\n- 来源：${doc.url}\n- 文档 id：${doc.id}\n\n${doc.text}\n`
}

/** 组装默认文件名：YYYY-MM-DD-<合法化标题>.md */
export function buildSaveFileName(title: string, now: Date = new Date()): string {
  return `${localDateString(now)}-${sanitizeFileName(title)}.md`
}

/** 冲突时追加序号：name.md → name-2.md → name-3.md …（最多尝试 50 次避免无限循环；存在性由传入的 exists 检查，便于测试）。 */
export async function dedupeFileName(
  dir: string,
  fileName: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(path.join(dir, fileName)))) return fileName
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 2; i <= 51; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!(await exists(path.join(dir, candidate)))) return candidate
  }
  // 达到上限：使用时间戳后缀
  const ts = Date.now().toString(36)
  return `${stem}-${ts}${ext}`
}

/** 单次批量保存的文档数上限（防误传全库 id 拖垮 API）。 */
export const SAVE_MAX_DOCS = 50

/** 把多篇文档合并为一份带目录的 Markdown（目录 → 各篇全文）。 */
export function mergeDocumentsToMarkdown(docs: OutlineDocument[], title: string): string {
  const head = [`# ${title}`, '', `- 导出时间：${new Date().toLocaleString()}`, `- 文档数：${docs.length}`, '', '## 目录', '']
  docs.forEach((d, i) => head.push(`${i + 1}. [${d.title}](${d.url})`))
  const body = docs.map((d) => `\n\n---\n\n${documentToMarkdown(d)}`).join('')
  return head.join('\n') + body
}

export function outlineSaveLocalTool(
  getSaveDir: () => string,
  makeClient: () => OutlineClient,
) {
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
      const dir = (getSaveDir() ?? '').trim()
      if (dir === '') {
        throw new Error('本地保存目录未配置。请在 设置 → 插件 → 插件配置 的「Outline 知识库」卡片中填写本地保存目录。')
      }
      // 落盘前的安全带：拒绝磁盘根/系统目录（目录由用户配置，这里只挡"明显不该写"的目标）
      const unsafeDir = checkSaveDir(dir)
      if (unsafeDir !== null) throw new Error(unsafeDir)
      const ids = [...new Set((args.ids ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))]
      if (ids.length === 0) {
        throw new Error('请提供至少一个文档 id（参数 ids，逗号分隔，来自 outline_search 结果）。')
      }
      if (ids.length > SAVE_MAX_DOCS) {
        throw new Error(`一次最多保存 ${SAVE_MAX_DOCS} 篇（当前 ${ids.length} 篇），请分批保存。`)
      }
      const client = makeClient()
      // 串行拉取：复用 getDocument 缓存，且对 Outline 限流友好（多篇合并场景 429 退避由 client 处理）。
      const docs: OutlineDocument[] = []
      for (const id of ids) {
        docs.push(await client.getDocument(id))
      }
      const defaultTitle = docs.length === 1 ? docs[0]!.title : `${docs[0]!.title}等${docs.length}篇`
      const title = (args.title ?? '').trim() !== '' ? (args.title ?? '').trim() : defaultTitle
      const markdown = docs.length === 1 ? documentToMarkdown(docs[0]!) : mergeDocumentsToMarkdown(docs, title)
      
      // ⚠️ Windows MAX_PATH=260：先构建原始文件名，再用 capFileNameLength 截断（确保不超过限制）
      const rawFileName = buildSaveFileName(title)
      const cappedFileName = capFileNameLength(dir, rawFileName)
      
      const fileName = await dedupeFileName(dir, cappedFileName, async (p) => {
        try {
          await stat(p)
          return true
        } catch {
          return false
        }
      })
      
      const filePath = path.join(dir, fileName)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(filePath, markdown, 'utf8')
      } catch (err) {
        // 📝 将系统错误码翻译为用户可操作提示（区分 Windows/macOS）
        throw new Error(formatFsError(err, filePath))
      }
      
      return { path: filePath, bytes: Buffer.byteLength(markdown, 'utf8'), documents: docs.length }
    },
  })
}

export function outlineSearchTool(
  makeClient: () => OutlineClient,
  defaultLimit: number,
  getSaveDir?: () => string,
  getSynonyms?: () => Record<string, string[]>,
) {
  return defineTool({
    name: 'outline_search',
    description: '在 Outline 知识库中按关键词搜索文档，返回该关键词的匹配总数、标题、命中片段、文档 id 与链接。可选按集合/作者/更新时间过滤。配置好 token 后即可检索全部文档。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'integer', description: `返回结果条数（默认 ${defaultLimit}，最大 ${SEARCH_MAX_LIMIT}）` },
      collectionId: { type: 'string', description: '可选，限定搜索某个集合（用 outline_list_collections 获取 id）' },
      author: { type: 'string', description: '可选，按作者过滤：姓名或邮箱（先精确后模糊匹配；匹配到多人时返回候选列表，请换 outline_list_users 查 id）' },
      userId: { type: 'string', description: '可选，按作者过滤（用户 id，精确值；可先用 outline_list_users 查询）' },
      updatedAfter: { type: 'string', description: '可选，只返回此时间之后更新的文档（ISO 日期或时间，如 2026-08-01）。Outline 1.12+ 在服务端过滤；更早版本无此能力，改为对取回的那一页本地筛选（返回 timeFilterMode=client 提示）' },
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
          timeFilterMode: { type: 'string', description: '时间过滤的生效位置：server = 服务端过滤（Outline 1.12+）；client = 实例不支持，已对取回的候选本地筛选，total 为筛选前总数' },
          scannedCount: { type: 'number', description: '本地筛选时实际扫描的候选条数（timeFilterMode=client 才有）；hits 已按时间筛过，本字段是筛前量' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text:
          (value.retriedWith !== undefined ? `（原查询无结果，已用 "${value.retriedWith}" 重试命中）\n` : '')
          + renderSearchResults(value, args.all === true)
          + (getSaveDir !== undefined ? renderLocalSaveHint(getSaveDir(), 'search') : ''),
      }],
    },
    async execute(args) {
      const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, args.limit ?? defaultLimit))
      const offset = Math.max(0, args.offset ?? 0)
      const client = makeClient()
      // 作者名 → userId 解析：优先精确/模糊匹配 users.list，下推到 Outline 服务端过滤（比盲搜人肉挑更高效、更省 token）。
      let resolvedUserId = args.userId
      if (args.author !== undefined && args.author.trim() !== '' && (resolvedUserId === undefined || resolvedUserId.trim() === '')) {
        const matches = await client.findUsers(args.author.trim())
        if (matches.length === 1) {
          resolvedUserId = matches[0]!.id
        } else if (matches.length > 1) {
          const candidates = matches.map((m) => `- ${m.name}（id: ${m.id}${m.email ? `, ${m.email}` : ''}）`).join('\n')
          throw new Error(`"${args.author}" 匹配到多位作者，请改用 outline_list_users 确认后传入 userId：\n${candidates}`)
        } else {
          throw new Error(`未找到名为 "${args.author}" 的作者（可先用 outline_list_users 查看全部成员）。`)
        }
      }
      const filters = { userId: resolvedUserId, updatedAfter: args.updatedAfter }
      /** 执行一次查询：默认单页；all=true 时抓全（上限 SEARCH_ALL_MAX，跨页按 id 去重）。
       *  抓取策略：① 按服务端单页上限（100）一次抓满 —— 同一实例实测比 4×limit25 串行快约 30%，
       *  且服务端只跑一次检索；返回集合与顺序与逐页串行完全一致。
       *  ② 实例上限更低（返回条数少于请求条数）时，以实际页长为步长并发补齐余下页面。 */
      const runQuery = async (q: string): Promise<OutlineSearchResult> => {
        if (args.all !== true) {
          return client.searchDocuments(q, limit, args.collectionId, filters, offset)
        }
        const hits: OutlineSearchHit[] = []
        const seen = new Set<string>()
        let total = 0
        /** 本实例的时间过滤生效位置；翻页过程中任一页给出就沿用（同一实例不会中途变）。 */
        let mode: OutlineSearchResult['timeFilterMode']
        /** 已向服务端扫描过的原始条数（本地筛选前）。翻页进度必须用它衡量：
         *  client 模式下 hits 被筛过，用 hits 算会误判成「已经到底」。 */
        let scanned = 0
        /** 吸收一页结果：返回该页新增（未见过）条数。 */
        const absorb = (r: OutlineSearchResult): number => {
          total = r.total
          if (r.timeFilterMode !== undefined) mode = r.timeFilterMode
          scanned += r.scannedCount ?? r.hits.length
          let fresh = 0
          for (const h of r.hits) {
            if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); fresh += 1 }
          }
          return fresh
        }
        /** 统一的返回：把时间过滤状态一并带出，否则渲染层看不到 client 模式、会按
         *  「筛前 total」算「还有多少篇未显示」。 */
        const collect = (): OutlineSearchResult => ({
          total,
          hits: hits.slice(0, SEARCH_ALL_MAX),
          ...(mode !== undefined ? { timeFilterMode: mode } : {}),
          ...(mode === 'client' ? { scannedCount: scanned } : {}),
        })
        /** 本次允许扫描的候选上限：本地筛选会筛掉大量候选，窗口要放宽，否则命中被严重低估。 */
        const scanCap = (): number => (mode === 'client' ? SEARCH_ALL_SCAN_MAX : SEARCH_ALL_MAX)
        const done = (): boolean => scanned >= Math.min(total, scanCap()) || hits.length >= SEARCH_ALL_MAX
        // ① 一次抓满（limit 取「服务端上限」与「本工具总上限」的较小值）
        const want = Math.min(SEARCH_ALL_MAX, OUTLINE_MAX_PAGE_SIZE)
        const first = await client.searchDocuments(q, want, args.collectionId, filters, 0)
        absorb(first)
        // client 模式下 hits 为 0 只表示「这一页候选里没有满足时间条件的」，不代表后面也没有；
        // 只有真没扫到任何候选（scanned=0）或已覆盖完目标窗口才收工。
        if (scanned === 0 || done() || (first.hits.length === 0 && first.timeFilterMode !== 'client')) {
          return collect()
        }
        // ② 兜底：服务端把 limit 压小（短页）时，先顺序探测下一页确认 offset 真的生效
        //    （部分实例无视 offset 每次都返回同一页），确认后再并发补齐余下页面。
        //    步长必须用服务端真实返回的条数：client 模式下 hits 已被本地筛少，
        //    拿它当步长会让 offset 落回已抓区间，抓到的全是重复项后误判到底。
        const step = first.scannedCount ?? first.hits.length
        const second = await client.searchDocuments(q, step, args.collectionId, filters, step)
        const freshSecond = absorb(second)
        // client 模式下一页被筛空（freshSecond=0）是正常现象，继续翻到 done() 为止；
        // 服务端模式下 freshSecond=0 说明 offset 没生效（整页重复），必须立刻停，防死循环。
        if (scanned === 0 || done() || (freshSecond === 0 && second.scannedCount === undefined)) {
          return collect()
        }
        const offsets: number[] = []
        const cap = scanCap()
        for (let off = step * 2; off < cap && off < Math.min(total, cap); off += step) offsets.push(off)
        if (offsets.length > 0) {
          const rest = await mapWithConcurrency(offsets, SEARCH_ALL_CONCURRENCY, (off) =>
            client.searchDocuments(q, step, args.collectionId, filters, off))
          for (const r of rest) absorb(r)
        }
        return collect()
      }
      let result = await runQuery(args.query)
      let effectiveQuery = args.query
      // 零命中回退阶梯：原词 → 首词（多词查询易 AND 落空）→ 同义词表变体（配置 synonyms）。
      if (result.hits.length === 0 && result.total === 0) {
        const terms = args.query.trim().split(/\s+/)
        const attempts: string[] = []
        if (terms.length > 1 && terms[0] !== undefined && terms[0] !== '') attempts.push(terms[0])
        if (getSynonyms !== undefined) attempts.push(...synonymVariants(args.query, getSynonyms()))
        for (const attempt of attempts.filter((v, i) => attempts.indexOf(v) === i)) {
          const retried = await runQuery(attempt)
          if (retried.hits.length > 0) {
            result = { ...retried, retriedWith: attempt }
            effectiveQuery = attempt
            break
          }
        }
      }
      // 本地重排：标题命中优先于摘要命中 + 新近度加成（同分保持服务端原序）。
      return { ...result, hits: rerankHits(result.hits, effectiveQuery) }
    },
  })
}

export function outlineListUsersTool(makeClient: () => OutlineClient) {
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
      render: (_args, value: OutlineUser[]) => [{
        type: 'text',
        text: value.length === 0
          ? '当前 token 可见范围内没有用户。'
          : `用户（${value.length} 个）：\n` + value.map((u) => `- ${u.name}（id: ${u.id}${u.email ? `, ${u.email}` : ''}）`).join('\n'),
      }],
    },
    async execute() {
      return makeClient().listUsers()
    },
  })
}

/** outline_context_search 返回的单条带摘要原文的命中。 */
export interface ContextSearchHit {
  id: string
  title: string
  url: string
  excerpt: string
  updatedAt: string
  snippet: string
}

/** 把带摘要的搜索结果渲染为模型可读文本：标题 + 链接 + 摘要原文（非仅片段）。 */
function renderContextSearchResult(
  total: number,
  hits: ContextSearchHit[],
  query: string,
): string {
  if (hits.length === 0) {
    return `关键词「${query}」未匹配到文档。可尝试更换关键词（如去掉停用词、改用更短的词）。`
  }
  const head = `🔍 知识库检索「${query}」命中 ${total} 篇，已拉取前 ${hits.length} 篇摘要原文：\n`
  const body = hits.map((hit, i) => {
    const excerpt = hit.excerpt.length > 0 ? `\n   ${hit.excerpt}` : '\n   （文档正文为空）'
    return `${i + 1}. [${escapeLinkText(hit.title)}](${wrapUrl(hit.url)})\n   更新：${hit.updatedAt}${excerpt}`
  }).join('\n\n')
  const tail = '\n\n以上摘要原文可直接引用作答。如需完整内容，请用 outline_get_document 工具（参数 id）。'
  return head + body + tail
}

export function outlineContextSearchTool(
  makeClient: () => OutlineClient,
  defaultLimit: number,
) {
  return defineTool({
    name: 'outline_context_search',
    description: '搜索 Outline 知识库并直接返回命中文档的摘要原文（前 800 字正文，非仅片段），供直接引用作答。比 outline_search 返回更丰富的内容，适合"查一下知识库里有没有相关文档并直接用其内容回答"的场景。搜索零命中时自动用首词/同义词重试。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'integer', description: `拉取摘要的文档数（默认 ${defaultLimit}，最大 ${SEARCH_MAX_LIMIT}）；每篇摘取前 800 字正文` },
      collectionId: { type: 'string', description: '可选，限定搜索某个集合' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true, description: '该关键词在知识库中的匹配总数' },
          query: { type: 'string', required: true, description: '实际生效的搜索词（零命中重试后可能与原词不同）' },
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
                excerpt: { type: 'string', required: true, description: '文档正文前 800 字的摘要原文' },
                updatedAt: { type: 'string', required: true },
                snippet: { type: 'string', required: true, description: 'Outline 服务端返回的命中片段' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderContextSearchResult(value.total, value.hits, value.query),
      }],
    },
    async execute(args) {
      const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, args.limit ?? defaultLimit))
      const client = makeClient()
      const result = await client.searchWithExcerpts(args.query, limit, args.collectionId)
      const hits: ContextSearchHit[] = result.excerpts.map((ex, i) => ({
        id: ex.id,
        title: ex.title,
        url: ex.url,
        excerpt: ex.excerpt,
        updatedAt: ex.updatedAt,
        snippet: result.hits[i]?.snippet ?? '',
      }))
      // 零命中回退：首词重试
      if (hits.length === 0 && result.total === 0) {
        const terms = args.query.trim().split(/\s+/)
        if (terms.length > 1 && terms[0] !== undefined && terms[0] !== '') {
          const retried = await client.searchWithExcerpts(terms[0], limit, args.collectionId)
          if (retried.excerpts.length > 0) {
            return {
              total: retried.total,
              query: terms[0],
              hits: retried.excerpts.map((ex, i) => ({
                id: ex.id, title: ex.title, url: ex.url, excerpt: ex.excerpt,
                updatedAt: ex.updatedAt, snippet: retried.hits[i]?.snippet ?? '',
              })),
            }
          }
        }
      }
      return { total: result.total, query: args.query, hits }
    },
  })
}

export function outlineCountTool(makeClient: () => OutlineClient) {
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
      return { total: await makeClient().countDocuments() }
    },
  })
}

export function outlineGetDocumentTool(makeClient: () => OutlineClient, getSaveDir?: () => string) {
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
      const maxLength = Math.min(DOCUMENT_MAX_LENGTH_CAP, Math.max(1000, args.maxLength ?? DOCUMENT_DEFAULT_MAX_LENGTH))
      const doc = await makeClient().getDocument(args.id)
      const truncated = doc.text.length > maxLength
      return { ...doc, text: truncated ? doc.text.slice(0, maxLength) : doc.text, truncated }
    },
  })
}

/** 审批提示文案：完整路径 + 标题 + 内容预览（前 100 字，纯函数可单测）。 */
export function buildCreateApprovalReason(
  args: { collectionId?: string; title?: string; text?: string },
  collectionName?: string,
  resolvedPath?: string[],
): string {
  const location = resolvedPath !== undefined && resolvedPath.length > 0
    ? `路径：${resolvedPath.join(' / ')}`
    : `集合「${collectionName && collectionName !== '' ? collectionName : (args.collectionId ?? '未知集合')}」`
  const preview = (args.text ?? '').replace(/\s+/g, ' ').slice(0, 100)
  return `在以下位置创建 Outline 文档：\n${location}\n标题：「${args.title ?? '(无标题)'}」\n内容预览：${preview}${(args.text ?? '').length > 100 ? '…' : ''}`
}

/** 白名单条目：一个可写目录路径。segments 为空表示整个集合可写。 */
export interface WritablePathEntry {
  collectionName: string
  segments: string[]
}

/** 解析可写目录配置（逗号分隔，反斜杠视为层级分隔）：`集合名` 或 `集合名/目录 A/子目录 B`。 */
export function parseWritablePaths(raw: string): WritablePathEntry[] {
  const normalized = (raw ?? '').replace(/\\+/g, '/')
  return normalized.split(',').map((x) => x.trim()).filter((x) => x !== '').map((path) => {
    const segments = path.split('/').map((s) => s.trim()).filter((s) => s !== '')
    const collectionName = segments.shift() ?? ''
    return { collectionName, segments }
  })
}

/** 写入目标的两种形态：创建（目标位置）与更新/删除（目标文档）。 */
export type WritePathTarget =
  | { kind: 'create'; collectionId: string; parentDocumentId?: string }
  | { kind: 'doc'; docId: string }

/**
 * 目录级写入守卫：目标路径必须落在白名单条目内（前缀匹配，fail-closed）。
 * - 白名单为空 → 拒绝（插件为只读模式）
 * - 目标路径解析失败（集合/文档不可见）→ 拒绝
 * - 条目 `集合A/目录1` 匹配 `[集合A, 目录1, …任意子级]`；`集合A` 匹配整个集合
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export async function resolvePathGuard(
  client: OutlineClient,
  target: WritePathTarget,
  entries: WritablePathEntry[],
  collections: OutlineCollection[],
): Promise<string | null> {
  if (entries.length === 0) {
    return '插件当前为只读模式：未配置可写目录。请在 设置 → 插件 → 插件配置 中填写可写目录（逗号分隔，如 集合A,集合B/目录1）。'
  }
  let targetPath: string[]
  try {
    if (target.kind === 'create') {
      const coll = collections.find((c) => c.id === target.collectionId.trim())
      if (coll === undefined) {
        return `无法确认写入目标集合（${target.collectionId}）：集合不存在或当前 token 无权查看。为避免误写，本次操作已拒绝。`
      }
      targetPath = target.parentDocumentId !== undefined && target.parentDocumentId !== ''
        ? await client.resolveDocumentPath(target.parentDocumentId, true)
        : [coll.name]
    } else {
      targetPath = await client.resolveDocumentPath(target.docId, true)
    }
  } catch {
    return '无法解析写入目标路径：目标集合或文档不可见。为避免误写，本次操作已拒绝。'
  }
  if (targetPath.length === 0) return '无法解析写入目标路径：目标位置为空。为避免误写，本次操作已拒绝。'
  const collectionName = targetPath[0]
  const rest = targetPath.slice(1)
  const matched = entries.some((e) => {
    if (normalizeName(e.collectionName) !== normalizeName(collectionName)) return false
    if (e.segments.length > rest.length) return false
    return e.segments.every((seg, i) => normalizeName(seg) === normalizeName(rest[i]))
  })
  if (!matched) {
    const allowed = entries.map((e) => e.segments.length === 0 ? e.collectionName : `${e.collectionName}/${e.segments.join('/')}`).join('、')
    return `禁止写入「${targetPath.join(' / ')}」：目标不在可写目录内。已配置可写目录：${allowed}。如需写入，请在 设置 → 插件 → 插件配置 中添加该路径。`
  }
  return null
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
].join('\n')

/** 模板的章节清单（供 AI 核对是否写全）。 */
export const REQUIREMENT_DOC_SECTIONS = ['需求或目标', '交付物', '交付标准', '交付时间', '潜在风险点', '解决的问题', '工作思路', '备注', '当前状态']

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
      return { template: REQUIREMENT_DOC_TEMPLATE, sections: [...REQUIREMENT_DOC_SECTIONS] }
    },
  })
}

/** Outline 权限中允许文档写入的值。未知权限按只读处理，避免兼容层误放行。 */
const WRITE_PERMISSIONS = new Set(['read_write', 'manage', 'admin'])

/**
 * 基础写入守卫：必须确认集合存在且 token 有写权限。
 * @returns 禁止或无法确认时返回错误提示文案；允许时返回 null。
 */
export function resolveWriteGuard(collections: OutlineCollection[], collectionId: string): string | null {
  const normalizedId = collectionId.trim()
  if (normalizedId === '') return '无法确认写入目标：缺少 collectionId。请先使用 outline_list_collections 或 outline_resolve_path。'
  const collection = collections.find((c) => c.id === normalizedId)
  if (collection === undefined) {
    return `无法确认写入目标集合（${normalizedId}）：集合列表不可用、集合不存在，或当前 token 无权查看。为避免误写，本次操作已拒绝。`
  }
  const name = collection.name.trim()
  const permission = collection.permission.trim().toLowerCase()
  if (!WRITE_PERMISSIONS.has(permission)) {
    return `禁止在集合「${name || normalizedId}」写入文档：当前 token 的集合权限为「${collection.permission || '未知'}」。`
  }
  return null
}

/** 名称归一化：小写并去掉破折号/空格/下划线/括号，容忍"张三"与"张-三"这类差异。 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_·\s（）()]/g, '')
}

/** 在候选中按名称匹配：先精确（归一化后），再包含匹配；多个命中返回 null 并给出候选。 */
function matchName(candidates: Array<{ id: string; name: string }>, wanted: string): { id: string; name: string } | null {
  const target = normalizeName(wanted)
  const exact = candidates.filter((c) => normalizeName(c.name) === target)
  if (exact.length === 1) return exact[0]
  const partial = candidates.filter((c) => normalizeName(c.name).includes(target))
  if (partial.length === 1) return partial[0]
  return null
}

export function outlineResolvePathTool(makeClient: () => OutlineClient) {
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
      const client = makeClient()
      // 接受正斜杠和反斜杠（Windows 用户自然输入习惯）
      const segments = (args.path ?? '').replace(/\\+/g, '/').split('/').map((s) => s.trim()).filter((s) => s !== '')
      if (segments.length === 0) throw new Error('路径不能为空，格式：集合名/目录1/目录2/...')

      // 第一段：集合
      const collections = await client.listCollections()
      const coll = matchName(collections, segments[0])
      if (coll === null) {
        throw new Error(`找不到集合「${segments[0]}」。可见集合：${collections.map((c) => c.name).join('、')}`)
      }

      // 后续段：逐级定位子文档（目录）
      // 根层级用集合内搜索（顶层目录名通常较短）；更深层级用 documents.list 拉全量子文档本地匹配（避免搜索分词歧义）。
      const resolvedNames = [coll.name]
      let parentId: string | undefined
      for (const seg of segments.slice(1)) {
        let candidates: Array<{ id: string; name: string }>
        if (parentId === undefined) {
          const { hits } = await client.searchDocuments(seg, 25, coll.id)
          candidates = hits
            .filter((h) => h.parentDocumentId === undefined || h.parentDocumentId === null || h.parentDocumentId === '')
            .map((h) => ({ id: h.id, name: h.title }))
        } else {
          candidates = (await client.listChildDocuments(parentId)).map((h) => ({ id: h.id, name: h.title }))
        }
        const matched = matchName(candidates, seg)
        if (matched === null) {
          const available = candidates.length > 0 ? `候选：${candidates.map((c) => c.name).join('、')}` : '该层级没有匹配的子文档'
          throw new Error(`在「${resolvedNames.join(' / ')}」下找不到「${seg}」。${available}`)
        }
        parentId = matched.id
        resolvedNames.push(matched.name)
      }

      return {
        collectionId: coll.id,
        ...(parentId !== undefined ? { parentDocumentId: parentId } : {}),
        path: resolvedNames,
      }
    },
  })
}

export function outlineListCollectionsTool(makeClient: () => OutlineClient) {
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
      return makeClient().listCollections()
    },
  })
}

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
export const CREATE_ARG_KEYS = ['collectionId', 'parentDocumentId', 'title', 'text', 'publish'] as const
export const UPDATE_ARG_KEYS = ['id', 'title', 'text', 'append', 'publish'] as const
export const DELETE_ARG_KEYS = ['id'] as const

/** 前缀式截断告警的触发门槛：按前缀判定时，至少要"少这么多字符"才值得打扰用户。 */
export const TRUNCATION_PREFIX_MIN_LOST = 1000

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
export function detectTruncatedRewrite(originalText: string, nextText: string): string | null {
  if (nextText === '' || nextText.length >= originalText.length) return null
  const lost = originalText.length - nextText.length
  const atDefaultCap = nextText.length === DOCUMENT_DEFAULT_MAX_LENGTH
  const isLongPrefix = originalText.startsWith(nextText) && lost >= TRUNCATION_PREFIX_MIN_LOST
  if (!atDefaultCap && !isLongPrefix) return null
  const why = atDefaultCap
    ? `新正文长度恰为 outline_get_document 的默认上限 ${DOCUMENT_DEFAULT_MAX_LENGTH}`
    : '新正文是原文的精确前缀'
  return `⚠️ 疑似把读取时被截断的正文写回（${why}）：原文 ${originalText.length} 字符 → 写回 ${nextText.length} 字符，将永久丢失 ${lost} 字符。`
    + '\n若本意是追加内容，请改用 append: true（追加不会覆盖原文）；'
    + '\n若本意是整体重写，请重新调用 outline_get_document 并把 maxLength 调大（上限 200000）后再修改。'
}

/**
 * 拒绝未声明的写入参数。纯函数（直接抛错），可单测。
 * @param toolName 工具名（用于错误文案）
 * @param args 模型传入的原始参数
 * @param allowed 已声明参数键
 */
export function assertKnownWriteArgs(
  toolName: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(args ?? {}).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return
  throw new Error(
    `${toolName} 不接受参数：${unknown.map((key) => `"${key}"`).join('、')}。`
    + `可用参数：${allowed.join('、')}。`
    + '（为避免"返回成功但变更未生效"，本工具不静默忽略未知写入参数。）',
  )
}

export function outlineCreateTool(makeClient: () => OutlineClient, getWritablePaths: () => string) {
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
          published: { type: 'boolean', description: '是否已发布（实例未返回该字段时缺省，不再默认当作已发布）' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.published === false
          ? `📝 已创建草稿（未发布）：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`
          : value.published === true
            ? `✅ 已创建并发布文档：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`
            : `✅ 已创建文档（服务端未返回发布状态）：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`,
      }],
    },
    async execute(args) {
      assertKnownWriteArgs('outline_create', args as Record<string, unknown>, CREATE_ARG_KEYS)
      const client = makeClient()
      const collections = await client.listCollections()
      // 写入守卫（防御纵深，即使绕过审批直调也会被拦）：目录白名单 → 集合存在与权限
      const pathGuard = await resolvePathGuard(
        client,
        { kind: 'create', collectionId: args.collectionId, parentDocumentId: args.parentDocumentId },
        parseWritablePaths(getWritablePaths()),
        collections,
      )
      if (pathGuard !== null) throw new Error(pathGuard)
      const guard = resolveWriteGuard(collections, args.collectionId)
      if (guard !== null) throw new Error(guard)
      return client.createDocument({
        collectionId: args.collectionId,
        parentDocumentId: args.parentDocumentId,
        title: args.title,
        text: args.text,
        publish: args.publish,
      })
    },
  })
}

export function outlineUpdateDocumentTool(makeClient: () => OutlineClient, getWritablePaths: () => string) {
  return defineTool({
    name: 'outline_update_document',
    description: '更新已有 Outline 文档的标题/正文/发布状态（写操作，执行前需用户审批，审批展示文档完整路径）。注意：text 是**整体替换**正文，必须传完整内容；只想追加内容请传 append: true（不覆盖原文），否则会覆盖掉未包含的原文。',
    parameters: {
      id: { type: 'string', required: true, description: '文档 id（来自 outline_search / outline_get_document）' },
      title: { type: 'string', description: '可选，新标题' },
      text: { type: 'string', description: '可选，新 Markdown 正文；**整体替换**原文，必须传完整内容（要追加请用 append: true）' },
      append: { type: 'boolean', description: '可选，true = 把 text 追加到正文末尾（Outline 原生 append 语义），不覆盖原文；默认 false = 整体替换' },
      publish: { type: 'boolean', description: '可选，发布状态：true = 发布，false = 转为草稿；不传则该状态不变' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          published: { type: 'boolean', description: '是否已发布（实例未返回该字段时缺省，不再默认当作已发布）' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.published === false
          ? `✏️ 已更新文档（当前为草稿）：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`
          : `✏️ 已更新文档：${escapeLinkText(value.title)} → ${wrapUrl(value.url)}`,
      }],
    },
    async execute(args) {
      assertKnownWriteArgs('outline_update_document', args as Record<string, unknown>, UPDATE_ARG_KEYS)
      // 参数校验：pre-execute 钩子会拦截；此处做 fail-closed 兜底（防止绕过审批直调时静默成功）
      if ((args.title === undefined || args.title === '')
        && (args.text === undefined || args.text === '')
        && args.publish === undefined) {
        throw new Error('outline_update_document 至少需要 title / text / publish 之一')
      }
      const client = makeClient()
      // force=true：与审批闸同源 —— 写决策不能建立在 60s 前的读上（集合归属会被带外移动/改名影响）
      const doc = await client.getDocument(args.id, true)
      const collections = await client.listCollections()
      const pathGuard = await resolvePathGuard(client, { kind: 'doc', docId: args.id }, parseWritablePaths(getWritablePaths()), collections)
      if (pathGuard !== null) throw new Error(pathGuard)
      const guard = resolveWriteGuard(collections, doc.collectionId ?? '')
      if (guard !== null) throw new Error(guard)
      return client.updateDocument(args.id, { title: args.title, text: args.text, append: args.append, publish: args.publish })
    },
  })
}

/**
 * 二次审批回调：由 index.ts 接线到 ctx.approval.request，返回是否 allowed-once。
 * `exec.signal` 必须一并透传 —— 宿主的 approval.request 用它做协作式取消竞速
 * （`decide()` 在 signal 已中止时直接返回 cancelled；宿主自己的 serviceAsk 也是这么传的）。
 * 不透传的话，用户在第二次弹窗期间取消本轮，这个 promise 不会以 cancelled 收敛。
 */
export type DeleteApprovalRequester = (
  reason: string,
  exec: { agent?: unknown; callId?: unknown; signal?: unknown },
) => Promise<boolean>

export function outlineDeleteTool(
  makeClient: () => OutlineClient,
  getWritablePaths: () => string,
  requestApproval: DeleteApprovalRequester,
) {
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
      assertKnownWriteArgs('outline_delete', args as Record<string, unknown>, DELETE_ARG_KEYS)
      const client = makeClient()
      // force=true：与审批闸同源 —— 写决策不能建立在 60s 前的读上（集合归属会被带外移动/改名影响）
      const doc = await client.getDocument(args.id, true)
      const collections = await client.listCollections()
      const pathGuard = await resolvePathGuard(client, { kind: 'doc', docId: args.id }, parseWritablePaths(getWritablePaths()), collections)
      if (pathGuard !== null) throw new Error(pathGuard)
      const guard = resolveWriteGuard(collections, doc.collectionId ?? '')
      if (guard !== null) throw new Error(guard)
      // 第二道审批（第一道在 pre-execute 钩子）；暂停等待用户点同意
      const ok = await requestApproval(
        `再次确认删除文档（不可恢复）：\n路径：${(await client.resolveDocumentPath(args.id)).join(' / ')}\n标题：「${doc.title}」`,
        exec,
      )
      if (!ok) throw new Error('删除已被用户取消（第二道确认未通过）。')
      const result = await client.deleteDocument(args.id)
      return { success: result.success, id: args.id }
    },
  })
}

export function outlineListChildrenTool(makeClient: () => OutlineClient) {
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
      return makeClient().listChildDocuments(args.parentId)
    },
  })
}
