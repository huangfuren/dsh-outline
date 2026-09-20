// dsh-outline 热安装/热卸载脚本 —— 安装后无需重启 dsh web
//
// 原理：DSH 对 profile 的 cordis.patch.yml 做热加载（HMR），
// 把插件作为 insert 行追加进去会即时重组 loader 树（宿主端立即生效，
// 全部 10 个工具：outline_search / outline_get_document / outline_count / outline_list_collections /
// outline_resolve_path / outline_list_children / outline_doc_template / outline_create /
// outline_update_document / outline_delete 马上可用）；客户端模块系统增量扫描
// loader 树，浏览器刷新一次页面后设置卡片即出现。
//
// 用法（在插件目录内执行）：
//   node scripts/hot-install.mjs            # 热安装到 web profile（无需重启）
//   node scripts/hot-install.mjs --profile headless
//   node scripts/hot-install.mjs --update    # 更新已安装的插件（git pull + 生效说明）
//   node scripts/hot-install.mjs --remove    # 热卸载
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
const PACKAGE_NAME = PKG.name // dsh-outline
const ROW_ID = 'outline-auto'
const LEGACY_PACKAGE_NAME = 'dsh-outline-ai'
const LEGACY_ROW_ID = 'outline-ai'
const INSERT_BLOCK = `- insert:\n    - id: ${ROW_ID}\n      name: '${PACKAGE_NAME}'\n`

const args = process.argv.slice(2)
const profileIdx = args.indexOf('--profile')
const profileArg = args.find((a) => a.startsWith('--profile=')) ?? (profileIdx >= 0 ? args[profileIdx + 1] : undefined)
const profile = profileArg ?? 'web'
const remove = args.includes('--remove')
const update = args.includes('--update')

const home = process.env.USERPROFILE ?? process.env.HOME
if (!home) {
  console.error('无法确定用户主目录（USERPROFILE/HOME 未设置）')
  process.exit(2)
}

// 插件目录若在临时位置（如 TEMP），提示克隆到稳定路径，避免删掉临时目录后 junction 失效。
const tempDirs = [process.env.TEMP, process.env.TMP, '/tmp', '/var/tmp'].filter(Boolean)
const looksTemporary = tempDirs.some((dir) => PLUGIN_DIR.toLowerCase().startsWith(dir.toLowerCase()))
const STABLE_CLONE_DIR = join(home, '.dsh', 'plugins', PACKAGE_NAME)

const profileDir = join(home, '.dsh', 'profiles', profile)
const nmDir = join(profileDir, 'node_modules')
const linkPath = join(nmDir, PACKAGE_NAME)
const patchPath = join(profileDir, 'cordis.patch.yml')

/** Windows 下删除符号链接/junction（目录型）；非 Windows 用 fs.rmSync。 */
function removeLink(path) {
  if (!existsSync(path)) return false
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'rmdir', path], { stdio: 'ignore' })
  } else {
    rmSync(path, { recursive: true, force: true })
  }
  return true
}

function readPatch() {
  return existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
}

/** 读取 profile package.json（不存在返回 null）。 */
function readProfileManifest() {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/** Remove the old package name that otherwise makes dsh fail before the web UI starts. */
function migrateLegacyInstall() {
  const manifest = readProfileManifest()
  if (manifest !== null) {
    let changed = false
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(LEGACY_PACKAGE_NAME)) {
      manifest.dsh.profile.bundles = bundles.filter((name) => name !== LEGACY_PACKAGE_NAME)
      changed = true
    }
    const dependencies = manifest.dependencies
    if (dependencies !== null && typeof dependencies === 'object' && Object.hasOwn(dependencies, LEGACY_PACKAGE_NAME)) {
      delete dependencies[LEGACY_PACKAGE_NAME]
      changed = true
    }
    if (changed) {
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
      console.log(`[迁移] 已移除旧 profile 依赖 ${LEGACY_PACKAGE_NAME}，避免启动时解析失败`)
    }
  }

  const patch = readPatch()
  const lines = patch.split('\n')
  const cleaned = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const next = lines[i + 1] ?? ''
    const following = lines[i + 2] ?? ''
    const oldInsert = line.trim() === '- insert:'
      && next.includes(`id: ${LEGACY_ROW_ID}`)
      && following.includes(`name: '${LEGACY_PACKAGE_NAME}'`)
    if (oldInsert) {
      i += 2
      continue
    }
    cleaned.push(line)
  }
  const nextPatch = cleaned.join('\n')
  if (nextPatch !== patch) {
    writeFileSync(patchPath, nextPatch)
    console.log(`[迁移] 已移除 cordis.patch.yml 中的旧插件行 ${LEGACY_ROW_ID}`)
  }
  if (removeLink(join(nmDir, LEGACY_PACKAGE_NAME))) {
    console.log(`[迁移] 已移除旧插件链接 node_modules/${LEGACY_PACKAGE_NAME}`)
  }
}

/** 插件是否已通过 bundles 安装（dsh plugin add 方式，启动时加载，非热加载）。 */
function isBundleInstalled() {
  const manifest = readProfileManifest()
  return manifest?.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true
}

/** profile patch 中是否已存在本插件的 insert 行（- insert: 下带 id: outline-auto）。 */
function hasInsertRow(patch) {
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('- insert:') && lines[i + 1]?.includes(`id: ${ROW_ID}`)) return true
  }
  return false
}

function install() {
  // 0) 已在 bundles 里安装过 → 再追加 insert 行会产生重复 id，跳过并说明
  if (isBundleInstalled()) {
    console.log(`[已通过 bundles 安装] ${PACKAGE_NAME} 已在 profile 的 dsh.profile.bundles 中（重启 GUI 后生效）。`)
    console.log('为避免重复行（同一 id 被插入两次），热安装不会追加 insert。')
    console.log('若想改成纯热安装：先从 bundles 移除（dsh plugin --profile ' + profile + ' remove ' + PACKAGE_NAME + '），再重新执行本脚本。')
    return
  }

  // 1) junction 进 profile node_modules（模块解析入口）
  if (existsSync(linkPath)) {
    console.log(`[已存在] node_modules/${PACKAGE_NAME} —— 跳过`)
  } else {
    mkdirSync(nmDir, { recursive: true })
    symlinkSync(PLUGIN_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`[已链接] node_modules/${PACKAGE_NAME} → ${PLUGIN_DIR}`)
  }

  // 2) cordis.patch.yml 追加 insert 行（触发热加载）
  const patch = readPatch()
  if (hasInsertRow(patch)) {
    console.log(`[已存在] cordis.patch.yml 中的 insert 行 —— 跳过`)
  } else {
    const sep = patch.length > 0 && !patch.endsWith('\n') ? '\n' : ''
    writeFileSync(patchPath, patch + sep + INSERT_BLOCK)
    console.log(`[已追加] cordis.patch.yml: insert ${ROW_ID}（热加载已触发）`)
  }

  console.log('')
  console.log('✅ 热安装完成 —— 无需重启 dsh web：')
  console.log('   1. 宿主端已即时生效：对话里可直接用 outline_search / outline_get_document / outline_count')
  console.log('   2. 浏览器刷新一次页面（或重开设置），设置 → 插件 → 插件配置 出现 Outline 知识库 卡片')
  console.log('   3. 在卡片里填 baseUrl 与 API Token 即可使用')
  if (looksTemporary) {
    console.log('')
    console.log(`⚠️  插件当前位于临时目录（${PLUGIN_DIR}），删除该目录后插件将失效。`)
    console.log(`   建议把插件目录移到稳定位置（如 ${STABLE_CLONE_DIR}）后重新安装。`)
  }
}

function uninstall() {
  const patch = readPatch()
  const removedInsert = hasInsertRow(patch)
  if (removedInsert) {
    const cleaned = patch
      .split('\n')
      .filter((line, i, lines) => {
        const prev = lines[i - 1] ?? ''
        const next = lines[i + 1] ?? ''
        const isBlock = line.includes('- insert:') && next.includes(`id: ${ROW_ID}`)
          || line.includes(`id: ${ROW_ID}`) && prev.includes('- insert:')
        return !isBlock
      })
      .join('\n')
    writeFileSync(patchPath, cleaned)
    console.log('[已移除] cordis.patch.yml 中的 insert 行')
  } else {
    console.log('[无] cordis.patch.yml 中没有 insert 行')
  }
  if (removeLink(linkPath)) console.log(`[已移除] node_modules/${PACKAGE_NAME} 链接`)
  else console.log('[无] node_modules 链接不存在')
  console.log('')
  console.log('✅ 热卸载完成：宿主端已停止注册工具；刷新页面后卡片消失。')
}

/** 更新已安装的插件：git pull 拉新代码，并说明各半区的生效方式。 */
function updatePlugin() {
  const gitDir = join(PLUGIN_DIR, '.git')
  if (!existsSync(gitDir)) {
    console.error(`插件目录 ${PLUGIN_DIR} 不是 git clone（无 .git），无法 git pull。`)
    console.error('请手动替换插件文件，或删除后重新 clone 安装。')
    return
  }
  const dirty = execFileSync('git', ['-C', PLUGIN_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  if (dirty) {
    console.error('插件目录有未提交的本地改动，先处理再更新：\n' + dirty)
    process.exit(1)
  }
  console.log(`[更新] ${PACKAGE_NAME} @ ${PLUGIN_DIR}`)
  execFileSync('git', ['-C', PLUGIN_DIR, 'pull', '--ff-only'], { stdio: 'inherit' })
  console.log('')
  console.log('✅ 代码已更新到最新。生效方式：')
  console.log('   1. 客户端（设置卡片）：刷新浏览器页面即可看到新版本')
  console.log('   2. 宿主端（工具逻辑）：需重启 dsh web 加载新代码（DSH 当前未启用模块级热更新）')
}

if (remove) {
  console.log(`dsh-outline 热卸载 → profile: ${profile}`)
  uninstall()
} else if (update) {
  console.log(`dsh-outline 更新 → profile: ${profile}`)
  updatePlugin()
} else {
  console.log(`dsh-outline 热安装 → profile: ${profile}`)
  migrateLegacyInstall()
  install()
}
