import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Pins the .gitignore `data/` rule: it must be repo-root-anchored so source
 * under `client/src/data/` is never silently ignored (audit 06 P2).
 *
 * `git check-ignore` exit 0 = path is ignored; exit 1 = not ignored.
 */
function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(`git rev-parse failed: ${r.stderr || r.stdout}`)
  }
  return r.stdout.trim()
}

function checkIgnore(repoRelative: string): { ignored: boolean; rule: string | null } {
  const r = spawnSync(
    'git',
    ['check-ignore', '-v', '--', repoRelative],
    { cwd: repoRoot(), encoding: 'utf8' },
  )
  if (r.status === 0) {
    return { ignored: true, rule: (r.stdout || '').trim() || null }
  }
  if (r.status === 1) {
    return { ignored: false, rule: null }
  }
  throw new Error(
    `git check-ignore failed for ${repoRelative}: status=${r.status} stderr=${r.stderr}`,
  )
}

describe('gitignore data/ anchoring', () => {
  it('does not ignore client/src/data source fixtures', () => {
    // Untracked fixture path — must stay trackable for new lore modules.
    const result = checkIgnore('client/src/data/new-lore-fixture.ts')
    expect(result.ignored, `was ignored by: ${result.rule}`).toBe(false)
  })

  it('still ignores root and server runtime data dirs', () => {
    expect(checkIgnore('data/runtime.db').ignored).toBe(true)
    expect(checkIgnore('server/data/snapshot.json').ignored).toBe(true)
    expect(checkIgnore('client/data/cache.bin').ignored).toBe(true)
  })

  it('exposes the fixture path for manual git check-ignore', () => {
    // Documented pin from audit 06: operators can re-run this exact path.
    expect(resolve(repoRoot(), 'client/src/data/new-lore-fixture.ts')).toContain(
      'client/src/data/new-lore-fixture.ts',
    )
  })
})
