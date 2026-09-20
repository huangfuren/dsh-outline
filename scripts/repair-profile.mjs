import fs from 'node:fs'
import path from 'node:path'

const LEGACY_ID = 'outline-ai'
const LEGACY_PACKAGE = 'dsh-outline-ai'

function log(message, quiet) {
  if (!quiet) console.warn(`[dsh-outline] ${message}`)
}

function isProfileDirectory(value) {
  if (!value) return false
  const parts = path.resolve(value).split(/[\\/]+/).filter(Boolean)
  const profilesIndex = parts.findIndex((part) => part.toLowerCase() === 'profiles')
  if (profilesIndex < 0 || profilesIndex !== parts.length - 2) return false
  return ['web', 'headless'].includes(parts.at(-1).toLowerCase())
}

function resolveProfileDirectory(explicit) {
  if (explicit) return isProfileDirectory(explicit) ? path.resolve(explicit) : undefined
  return isProfileDirectory(process.env.INIT_CWD) ? path.resolve(process.env.INIT_CWD) : undefined
}

function removeLegacyPatchEntries(source) {
  const lines = source.split(/\r?\n/)
  const output = []
  const topLevelStarts = lines.reduce((starts, line, index) => {
    if (/^-\s+/.test(line)) starts.push(index)
    return starts
  }, [])
  if (topLevelStarts.length === 0) return source

  output.push(...lines.slice(0, topLevelStarts[0]))
  for (let blockIndex = 0; blockIndex < topLevelStarts.length; blockIndex += 1) {
    const start = topLevelStarts[blockIndex]
    const end = topLevelStarts[blockIndex + 1] ?? lines.length
    const block = lines.slice(start, end)
    if (block[0].trim() !== '- insert:') {
      output.push(...block)
      continue
    }

    const entryStarts = []
    for (let index = 1; index < block.length; index += 1) {
      if (/^\s+-\s+/.test(block[index])) entryStarts.push(index)
    }
    if (entryStarts.length === 0) {
      output.push(...block)
      continue
    }

    const retained = [block[0], ...block.slice(1, entryStarts[0])]
    for (let entryIndex = 0; entryIndex < entryStarts.length; entryIndex += 1) {
      const entryStart = entryStarts[entryIndex]
      const entryEnd = entryStarts[entryIndex + 1] ?? block.length
      const entry = block.slice(entryStart, entryEnd)
      const entryText = entry.join('\n')
      const isLegacy = /id:\s*['"]?outline-ai['"]?(?:\s|$)/.test(entryText) || /name:\s*['"]?dsh-outline-ai['"]?(?:\s|$)/.test(entryText)
      if (!isLegacy) retained.push(...entry)
    }
    if (retained.length > 1) output.push(...retained)
  }

  return output.join('\n')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function repairProfile(profileDir, { quiet = false } = {}) {
  if (!isProfileDirectory(profileDir)) {
    log('skipped profile migration because the target is not a DSH web/headless profile', quiet)
    return { changed: false, skipped: true }
  }

  try {
    const manifestFile = path.join(profileDir, 'package.json')
    const patchFile = path.join(profileDir, 'cordis.patch.yml')
    let changed = false

    if (fs.existsSync(manifestFile)) {
      const manifest = readJson(manifestFile)
      const bundles = manifest.dsh?.profile?.bundles
      let manifestChanged = false
      if (Array.isArray(bundles) && bundles.includes(LEGACY_PACKAGE)) {
        manifest.dsh.profile.bundles = bundles.filter((bundle) => bundle !== LEGACY_PACKAGE)
        manifestChanged = true
      }
      if (manifest.dependencies?.[LEGACY_PACKAGE]) {
        delete manifest.dependencies[LEGACY_PACKAGE]
        manifestChanged = true
      }
      if (manifestChanged) {
        writeJson(manifestFile, manifest)
        changed = true
      }
    }

    if (fs.existsSync(patchFile)) {
      const source = fs.readFileSync(patchFile, 'utf8')
      const repaired = removeLegacyPatchEntries(source)
      if (repaired !== source) {
        fs.writeFileSync(patchFile, repaired, 'utf8')
        changed = true
      }
    }

    if (changed) {
      log('removed stale dsh-outline-ai profile references; the next dsh plugin operation may refresh pnpm-lock.yaml', quiet)
    }
    return { changed, skipped: false }
  } catch (error) {
    log(`profile migration skipped: ${error instanceof Error ? error.message : String(error)}`, quiet)
    return { changed: false, skipped: true }
  }
}

function parseProfileArgument(argv) {
  const index = argv.indexOf('--profile-dir')
  return index >= 0 ? argv[index + 1] : undefined
}

const explicitProfileDir = parseProfileArgument(process.argv.slice(2))
const profileDir = resolveProfileDirectory(explicitProfileDir)
if (profileDir) repairProfile(profileDir, { quiet: process.argv.includes('--quiet') })
