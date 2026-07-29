#!/usr/bin/env node
/**
 * Per-IP hourly ledger survives flush + reload (restart).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runTest } from './_harness.mjs'

runTest(main)

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-ledger-'))
  const script = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'true';
    process.env.TURN_PROVIDER = 'cloudflare';
    process.env.TURN_CF_KEY_ID = 'k';
    process.env.TURN_CF_API_TOKEN = 't';
    process.env.TURN_CF_ACCOUNT_TAG = 'a';
    process.env.SERVER_SECRET = '11'.repeat(32);
    process.env.TURN_MAX_BYTES_PER_HOUR_PER_IP = '1000000';
    const p = await import('./dist/persist.js');
    await p.loadTurnState();
    const st = p.getTurnState();
    st.ipByteLedger.push({ ip: '198.51.100.9', bytes: 750000, at: Date.now() });
    p.markDirty();
    await p.flushTurnState(true);
    console.log('flushed');
  `
  const w = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(w.status, 0, w.stderr + w.stdout)

  const script2 = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const p = await import('./dist/persist.js');
    await p.loadTurnState();
    const st = p.getTurnState();
    const hit = st.ipByteLedger.find(e => e.ip === '198.51.100.9' && e.bytes === 750000);
    if (!hit) {
      console.error('FAIL missing ledger entry', JSON.stringify(st.ipByteLedger));
      process.exit(2);
    }
    console.log('ok');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script2], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  rmSync(dir, { recursive: true, force: true })
  console.log('✅ ledger persistence across restart tests passed')
}
