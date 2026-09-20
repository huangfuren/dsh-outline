import { test, expect } from 'vitest'
import path from 'node:path'
import { OutlineClient } from '../src/client.js'
import { sanitizeFileName, capFileNameLength, formatFsError, parseWritablePaths, dedupeFileName } from '../src/tools.js'

// ---------------------------------------------------------------------------
// IPv6 / URL 安全校验（macOS/Linux 常见 [::1] 回环写法）
// ---------------------------------------------------------------------------

test('assertAllowedUrl 接受带方括号的 IPv6 回环 [::1]', () => {
  expect(() => new OutlineClient({ baseUrl: 'http://[::1]:3000', apiToken: 'tok' })).not.toThrow()
  expect(() => new OutlineClient({ baseUrl: 'http://[::1]', apiToken: 'tok' })).not.toThrow()
})

test('assertAllowedUrl 仍接受 localhost / 127.0.0.1 / 内网 IPv4', () => {
  expect(() => new OutlineClient({ baseUrl: 'http://localhost:3000', apiToken: 'tok' })).not.toThrow()
  expect(() => new OutlineClient({ baseUrl: 'http://127.0.0.1:3000', apiToken: 'tok' })).not.toThrow()
  expect(() => new OutlineClient({ baseUrl: 'http://10.0.0.5', apiToken: 'tok' })).not.toThrow()
  expect(() => new OutlineClient({ baseUrl: 'http://192.168.1.10', apiToken: 'tok' })).not.toThrow()
})

test('assertAllowedUrl 拒绝公网明文 http', () => {
  expect(() => new OutlineClient({ baseUrl: 'http://example.com', apiToken: 'tok' })).toThrow(/拒绝非 HTTPS/)
})

test('assertAllowedUrl 放行任意 https 地址', () => {
  expect(() => new OutlineClient({ baseUrl: 'https://outline.example.com', apiToken: 'tok' })).not.toThrow()
})

// ---------------------------------------------------------------------------
// sanitizeFileName：Windows 保留名 / 首尾点空格 / 非法字符 / Unicode
// ---------------------------------------------------------------------------

test('sanitizeFileName 保护 Windows 保留设备名（CON/NUL/COM/LPT）', () => {
  expect(sanitizeFileName('CON')).toBe('CON_')
  expect(sanitizeFileName('nul')).toBe('nul_')
  expect(sanitizeFileName('COM9')).toBe('COM9_')
  expect(sanitizeFileName('LPT1')).toBe('LPT1_')
  // 带前后缀的不受影响
  expect(sanitizeFileName('CON 笔记')).toBe('CON 笔记')
})

test('sanitizeFileName 去掉首尾点与空格（Windows 会静默剪除）', () => {
  expect(sanitizeFileName('.foo')).toBe('foo')
  expect(sanitizeFileName('foo.')).toBe('foo')
  expect(sanitizeFileName('  foo  ')).toBe('foo')
  expect(sanitizeFileName('...')).toBe('untitled')
})

test('sanitizeFileName 仍替换文件系统非法字符', () => {
  expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
})

test('sanitizeFileName 保留合法空格、emoji 与中文', () => {
  expect(sanitizeFileName('测试 ✅ 🚀')).toBe('测试 ✅ 🚀')
  expect(sanitizeFileName('café notes')).toBe('café notes')
})

// ---------------------------------------------------------------------------
// capFileNameLength：Windows MAX_PATH 保护
// ---------------------------------------------------------------------------

test('capFileNameLength 在 Windows 下把超长路径压到 240 字符内', () => {
  const dir = 'C:\\Users\\Administrator\\AppData\\Roaming\\dsh\\profiles\\web\\outline-auto-saves'
  const fileName = `2026-09-20-${'部署规范'.repeat(200)}.md` // 800 chars → way over
  const capped = capFileNameLength(dir, fileName)

  if (process.platform === 'win32') {
    expect(path.join(dir, capped).length).toBeLessThanOrEqual(240)
    expect(capped.endsWith('.md')).toBe(true)
    expect(capped.length).toBeLessThan(fileName.length)
  } else {
    // 非 Windows：原样返回（POSIX 限额高得多）
    expect(capped).toBe(fileName)
  }
})

test('capFileNameLength 对短文件名不做任何改动', () => {
  const dir = process.platform === 'win32' ? 'D:\\notes' : '/tmp/notes'
  expect(capFileNameLength(dir, '2026-09-20-部署规范.md')).toBe('2026-09-20-部署规范.md')
})

// ---------------------------------------------------------------------------
// formatFsError：按平台给出可操作提示
// ---------------------------------------------------------------------------

test('formatFsError 对 ENOENT 给出平台相关提示', () => {
  const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  const hint = formatFsError(err, path.join('X:', 'a', 'b.md'))
  expect(hint).toContain('ENOENT')
  expect(hint).toContain(process.platform === 'win32' ? 'MAX_PATH' : '目录不存在')
})

test('formatFsError 对 EACCES/ENOSPC/未知码都有兜底', () => {
  expect(formatFsError(Object.assign(new Error('x'), { code: 'EACCES' }), 'p')).toContain('权限')
  expect(formatFsError(Object.assign(new Error('x'), { code: 'ENOSPC' }), 'p')).toContain('磁盘空间')
  const unknown = formatFsError(Object.assign(new Error('boom'), { code: 'EWEIRD' }), 'p')
  expect(unknown).toContain('EWEIRD')
  expect(unknown).toContain('boom')
})

// ---------------------------------------------------------------------------
// 反斜杠分隔符：Windows 用户的自然输入习惯
// ---------------------------------------------------------------------------

test('parseWritablePaths 接受反斜杠作为层级分隔符', () => {
  const result = parseWritablePaths('集合 A\\目录 1\\子目录 2, 集合 B')
  expect(result).toEqual([
    { collectionName: '集合 A', segments: ['目录 1', '子目录 2'] },
    { collectionName: '集合 B', segments: [] },
  ])
})

test('parseWritablePaths 正斜杠行为保持不变（向后兼容）', () => {
  expect(parseWritablePaths('集合 A/目录 1, 集合 B')).toEqual([
    { collectionName: '集合 A', segments: ['目录 1'] },
    { collectionName: '集合 B', segments: [] },
  ])
})

// ---------------------------------------------------------------------------
// dedupeFileName：上限保护，避免无限循环
// ---------------------------------------------------------------------------

test('dedupeFileName 冲突过多时回退时间戳后缀而不是无限重试', async () => {
  let calls = 0
  const alwaysExists = async () => { calls += 1; return true }
  const result = await dedupeFileName('/tmp/x', 'a.md', alwaysExists)
  expect(calls).toBeLessThanOrEqual(53) // 1 + 50 attempts + 1 guard
  expect(result).toMatch(/^a-[0-9a-z]+\.md$/)
})
