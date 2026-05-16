#!/usr/bin/env node
// CI guard: if a PR changes files under client/src/ or server/src/, it must
// also change at least one file under client/tests/ or server/tests/.
//
// Rationale: the project's recurring failure mode was "fix one thing, break
// another." Requiring an accompanying test edit (new test, updated assertion,
// or even an intentional removal) forces every behavioral change through the
// test suite. The author can override by adding `[skip-test-guard]` to the
// PR title or the latest commit message when the change is genuinely
// no-behavior (typo, doc string, dependency bump).
//
// Inputs (in priority order):
//   BASE_SHA / HEAD_SHA  — explicit refs (set by CI)
//   GITHUB_BASE_REF      — branch name on GitHub Actions PRs (falls back to origin/<ref>)
//   default              — diff against `origin/main`
//
// Exits 0 = ok, 1 = guard tripped.

import { execSync } from 'node:child_process'

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function changedFiles() {
  const base = process.env.BASE_SHA
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main')
  const head = process.env.HEAD_SHA || 'HEAD'

  // `...` finds the merge-base so we only count files changed on the PR side,
  // not files merged in from the base branch.
  const out = sh(`git diff --name-only ${base}...${head}`)
  return out ? out.split('\n').filter(Boolean) : []
}

function lastCommitMessage() {
  try {
    return sh('git log -1 --pretty=%B')
  } catch {
    return ''
  }
}

const files = changedFiles()
const srcTouched = files.some(f =>
  f.startsWith('client/src/') || f.startsWith('server/src/'),
)
const testsTouched = files.some(f =>
  f.startsWith('client/tests/') || f.startsWith('server/tests/'),
)

const override = (process.env.PR_TITLE || lastCommitMessage()).includes('[skip-test-guard]')

if (!srcTouched) {
  console.log('[guard] no src/ changes — guard does not apply.')
  process.exit(0)
}

if (testsTouched) {
  console.log('[guard] src/ touched AND tests/ touched — ok.')
  process.exit(0)
}

if (override) {
  console.log('[guard] src/ touched without tests/, but [skip-test-guard] is set — allowed.')
  process.exit(0)
}

console.error('')
console.error('❌ tests-touched guard tripped')
console.error('')
console.error('   Files under client/src/ or server/src/ changed, but no file')
console.error('   under client/tests/ or server/tests/ was touched.')
console.error('')
console.error('   Either:')
console.error('     • add a test that covers the change (preferred), or')
console.error('     • update an existing test if behavior changed, or')
console.error('     • add `[skip-test-guard]` to the PR title / latest commit')
console.error('       if the change is genuinely no-behavior (typo, docs, deps).')
console.error('')
console.error('   Changed src files:')
for (const f of files.filter(f => f.startsWith('client/src/') || f.startsWith('server/src/'))) {
  console.error(`     - ${f}`)
}
console.error('')
process.exit(1)
