#!/usr/bin/env node
/**
 * Changed-line coverage gate for server/src.
 *
 * Reads c8's coverage-final.json and scores git-diffed TypeScript lines in
 * server/src/*.ts. Coverage is matched through source maps (tsc emits
 * dist/*.js.map) so TS line numbers are never compared to unrelated
 * transpiled JS statement lines.
 *
 * Env:
 *   COVERAGE_JSON   path to coverage-final.json (default: coverage/coverage-final.json)
 *   BASE_REF        git ref to diff against (default: origin/main or HEAD~1)
 *   MIN_CHANGED_PCT minimum % of changed lines that must be covered (default 70)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(__dirname, '..')
const repoRoot = resolve(serverDir, '..')

/** Modules that the c8 --include gate tracks. Missing coverage for these is FAIL. */
const GATE_MODULES = new Set([
  'ratelimit',
  'store',
  'ws',
  'persist',
  'origin',
  'session-lifecycle',
])

const coveragePath = process.env.COVERAGE_JSON
  ? resolve(process.env.COVERAGE_JSON)
  : resolve(serverDir, 'coverage/coverage-final.json')
const minPct = Number(process.env.MIN_CHANGED_PCT || 70)

function findBaseRef() {
  if (process.env.BASE_REF) return process.env.BASE_REF
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`
  const main = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: repoRoot })
  if (main.status === 0) return 'origin/main'
  return 'HEAD~1'
}

function gitDiffLines(base) {
  // Unified diff with zero context → only changed lines.
  const r = spawnSync(
    'git',
    ['diff', '--unified=0', `${base}...HEAD`, '--', 'server/src'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (r.status !== 0) {
    // No base / no history — skip gate with a note rather than false-fail.
    console.warn(`[changed-line-coverage] git diff failed (${r.stderr || r.status}); skipping`)
    return null
  }
  const out = new Map() // relPath -> Set of 1-based line numbers
  let file = null
  for (const line of (r.stdout || '').split('\n')) {
    const mf = line.match(/^\+\+\+ b\/(.+)$/)
    if (mf) {
      file = mf[1]
      if (!out.has(file)) out.set(file, new Set())
      continue
    }
    const mh = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (mh && file) {
      const start = Number(mh[1])
      const count = mh[2] === undefined ? 1 : Number(mh[2])
      for (let i = 0; i < count; i++) out.get(file).add(start + i)
      continue
    }
  }
  return out
}

function loadCoverage() {
  if (!existsSync(coveragePath)) {
    // c8 may write under coverage/tmp — also try finding any coverage-final.json
    const covDir = resolve(serverDir, 'coverage')
    if (existsSync(covDir)) {
      const walk = (d) => {
        for (const name of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, name.name)
          if (name.isDirectory()) {
            const hit = walk(p)
            if (hit) return hit
          } else if (name.name === 'coverage-final.json') {
            return p
          }
        }
        return null
      }
      const found = walk(covDir)
      if (found) return JSON.parse(readFileSync(found, 'utf8'))
    }
    console.error(`[changed-line-coverage] missing ${coveragePath}`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(coveragePath, 'utf8'))
}

function coverageEntryFor(cov, candidates) {
  // Keys are absolute paths; match by suffix.
  for (const [k, v] of Object.entries(cov)) {
    const norm = k.replace(/\\/g, '/')
    for (const c of candidates) {
      if (norm.endsWith(c) || norm.endsWith('/' + c)) return { key: k, entry: v }
    }
  }
  return null
}

// ── Minimal source-map VLQ line mapper (generated line → original line) ──
// Enough to map TypeScript changed lines onto instrumented JS statements.

function fromVLQ(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = 0
  let shift = 0
  let i = 0
  while (i < str.length) {
    const c = chars.indexOf(str[i++])
    if (c < 0) break
    const digit = c & 31
    result |= digit << shift
    if ((c & 32) === 0) {
      const neg = result & 1
      result >>= 1
      return { value: neg ? -result : result, rest: str.slice(i) }
    }
    shift += 5
  }
  return { value: 0, rest: '' }
}

/**
 * Build Map<generatedLine(1-based), Set<originalLine(1-based)>> from a
 * TypeScript .js.map for the single source file of interest.
 */
function loadGeneratedToOriginal(mapPath, sourceBaseName) {
  if (!existsSync(mapPath)) return null
  let map
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'))
  } catch {
    return null
  }
  const sources = map.sources || []
  let sourceIndex = sources.findIndex(s => {
    const n = s.replace(/\\/g, '/')
    return n === sourceBaseName || n.endsWith('/' + sourceBaseName) || basename(n) === sourceBaseName
  })
  if (sourceIndex < 0 && sources.length === 1) sourceIndex = 0
  if (sourceIndex < 0) return null

  const genToOrig = new Map()
  let genLine = 0 // 0-based while parsing
  let origLine = 0
  let srcIdx = 0
  // unused: genCol, origCol, nameIdx — we only need lines
  for (const lineSeg of (map.mappings || '').split(';')) {
    let genCol = 0
    if (lineSeg.length > 0) {
      for (const seg of lineSeg.split(',')) {
        if (!seg) continue
        let rest = seg
        let v
        ;({ value: v, rest } = fromVLQ(rest)); genCol += v
        if (rest) {
          ;({ value: v, rest } = fromVLQ(rest)); srcIdx += v
          ;({ value: v, rest } = fromVLQ(rest)); origLine += v
          // origCol
          if (rest) { ;({ value: v, rest } = fromVLQ(rest)) }
          // name
          if (rest) { ;({ value: v, rest } = fromVLQ(rest)) }
          if (srcIdx === sourceIndex) {
            const g = genLine + 1
            const o = origLine + 1
            if (!genToOrig.has(g)) genToOrig.set(g, new Set())
            genToOrig.get(g).add(o)
          }
        }
      }
    }
    genLine++
  }
  return genToOrig
}

/**
 * Invert gen→orig into origLine → Set of generated lines.
 */
function invertMap(genToOrig) {
  const origToGen = new Map()
  for (const [g, origs] of genToOrig) {
    for (const o of origs) {
      if (!origToGen.has(o)) origToGen.set(o, new Set())
      origToGen.get(o).add(g)
    }
  }
  return origToGen
}

function statementCoverageByLine(entry) {
  const s = entry.s || {}
  const statementMap = entry.statementMap || {}
  const coveredLines = new Set()
  const executableLines = new Set()
  for (const [id, stmt] of Object.entries(statementMap)) {
    const start = stmt.start?.line
    const end = stmt.end?.line ?? start
    if (!start) continue
    for (let ln = start; ln <= end; ln++) {
      executableLines.add(ln)
      if ((s[id] || 0) > 0) coveredLines.add(ln)
    }
  }
  return { coveredLines, executableLines }
}

function moduleNameFromSrc(srcPath) {
  // server/src/foo.ts → foo
  return basename(srcPath).replace(/\.ts$/, '')
}

function main() {
  const base = findBaseRef()
  const changed = gitDiffLines(base)
  if (!changed) {
    console.log('[changed-line-coverage] skipped (no usable diff)')
    return
  }

  const srcFiles = [...changed.entries()].filter(([f]) => f.endsWith('.ts'))
  if (srcFiles.length === 0) {
    console.log('[changed-line-coverage] no server/src/*.ts changes; ok')
    return
  }

  const cov = loadCoverage()
  let total = 0
  let covered = 0
  const uncovered = []
  const missingCore = []

  for (const [srcPath, lines] of srcFiles) {
    const mod = moduleNameFromSrc(srcPath)
    const isCore = GATE_MODULES.has(mod)
    const srcBase = basename(srcPath) // store.ts
    const distJs = `dist/${mod}.js`
    const distMap = resolve(serverDir, `dist/${mod}.js.map`)

    // Prefer remapped TS entries (c8 with source maps), then raw dist JS.
    const hit =
      coverageEntryFor(cov, [
        `src/${srcBase}`,
        `server/src/${srcBase}`,
        srcPath,
        srcBase,
      ])
      || coverageEntryFor(cov, [distJs, `${mod}.js`])

    if (!hit) {
      if (isCore) {
        missingCore.push(srcPath)
        console.error(`[changed-line-coverage] FAIL: no coverage data for core module ${mod} (${srcPath})`)
      } else {
        console.warn(`[changed-line-coverage] no coverage data for ${srcPath} (not in gate includes); skipping`)
      }
      continue
    }

    const { coveredLines, executableLines } = statementCoverageByLine(hit.entry)
    const entryLooksLikeTs = /\.ts$/.test(hit.key) || hit.key.includes('/src/')

    let origToGen = null
    if (!entryLooksLikeTs) {
      const genToOrig = loadGeneratedToOriginal(distMap, srcBase)
      if (!genToOrig) {
        if (isCore) {
          missingCore.push(srcPath)
          console.error(
            `[changed-line-coverage] FAIL: no source map for ${distMap}; cannot map TS lines for ${srcPath}`,
          )
          continue
        }
        console.warn(`[changed-line-coverage] no source map for ${srcPath}; skipping`)
        continue
      }
      origToGen = invertMap(genToOrig)
    }

    for (const ln of lines) {
      if (entryLooksLikeTs) {
        // Coverage already remapped to TypeScript — compare TS lines directly.
        if (!executableLines.has(ln)) continue
        total++
        if (coveredLines.has(ln)) covered++
        else uncovered.push(`${srcPath}:${ln}`)
      } else {
        // Map TS line → generated JS lines, then check JS statement coverage.
        const gens = origToGen.get(ln)
        if (!gens || gens.size === 0) continue
        const execGens = [...gens].filter(g => executableLines.has(g))
        if (execGens.length === 0) continue
        total++
        if (execGens.some(g => coveredLines.has(g))) covered++
        else uncovered.push(`${srcPath}:${ln}`)
      }
    }
  }

  if (missingCore.length > 0) {
    console.error(
      `[changed-line-coverage] FAIL: ${missingCore.length} core module(s) missing from coverage report`,
    )
    process.exit(1)
  }

  if (total === 0) {
    console.log('[changed-line-coverage] no executable changed lines in instrumented modules; ok')
    return
  }

  const pct = (covered / total) * 100
  console.log(
    `[changed-line-coverage] ${covered}/${total} changed executable lines covered (${pct.toFixed(1)}%), floor ${minPct}%`,
  )
  if (uncovered.length > 0 && uncovered.length <= 30) {
    console.log('  uncovered:')
    for (const u of uncovered) console.log(`    ${u}`)
  } else if (uncovered.length > 30) {
    console.log(`  uncovered: ${uncovered.length} lines (first 20)`)
    for (const u of uncovered.slice(0, 20)) console.log(`    ${u}`)
  }

  if (pct + 1e-9 < minPct) {
    console.error(`[changed-line-coverage] FAIL: ${pct.toFixed(1)}% < ${minPct}%`)
    process.exit(1)
  }
  console.log('[changed-line-coverage] PASS')
}

main()
