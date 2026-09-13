/**
 * DSH bundle adapter for the dsh-outline-auto answer-style skill.
 *
 * Loads the plugin's own skill tree through the host-owned filesystem skill
 * provider, isolated to this package (no default project/user roots, no
 * watcher). Kept as a separate module so a failure here cannot take down the
 * main outline tools in lib/index.js. Mirrors the wiring used by the Aegis
 * method-pack.
 */
import { fileURLToPath } from 'node:url'
import { apply as applyFilesystemProvider } from '@deepseek-ai/dsh-skill-filesystem'

const skillsRoot = fileURLToPath(new URL('./skills/', import.meta.url))

export const name = 'outline-auto-skills'
export const inject = ['skills']

export function apply(ctx) {
  applyFilesystemProvider(ctx, {
    providerName: 'outline-auto-skills',
    includeDefaultRoots: false,
    bundledSkillDir: skillsRoot,
    watch: false,
  })
}
