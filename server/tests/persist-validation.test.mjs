#!/usr/bin/env node
/**
 * Snapshot validation fail-closed + durable write parent-fsync + lock quarantine.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTest } from './_harness.mjs'

runTest(main)

async function main() {
  await testNegativeCredentialFailsClosed()
  await testNegativeLedgerFailsClosed()
  await testDurableDirSyncFailureRejects()
  await testDurableDirSyncPlatformRefusalRejects()
  await testUnreadableLocksQuarantined()
  console.log('✅ persist validation / durability / quarantine tests passed')
}

function baseTurnState(extra = {}) {
  return {
    version: 1,
    monthlyUsage: {
      monthKey: '2026-07',
      bytesObserved: 1000,
      cfBytesObserved: 1000,
      pessimisticBytesObserved: 0,
      usageSource: 'cloudflare',
      lastCfSyncAt: Date.now(),
      killSwitchActive: false,
      killSwitchTriggeredAt: 0,
    },
    activeCredentials: {},
    ipIssuanceHistory: [],
    denyList: {},
    ipByteLedger: [],
    ...extra,
  }
}

async function loadFresh(dir) {
  process.env.TURN_PERSIST_DIR = dir
  // Force re-import of persist with this dir. config already bound TURN_PERSIST_DIR
  // at first import — set env BEFORE first import of this process.
  const persist = await import('../dist/persist.js')
  return persist
}

async function testNegativeCredentialFailsClosed() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-persist-cred-'))
  process.env.TURN_PERSIST_DIR = dir
  // Spawn isolated evaluation so TURN_PERSIST_DIR is read at config load.
  const { spawnSync } = await import('node:child_process')
  const script = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const state = ${JSON.stringify(baseTurnState({
      activeCredentials: {
        badcid: {
          sessionId: 'sess-1',
          ip: '1.2.3.4',
          issuedAt: 1,
          expiresAt: 2,
          pessimisticBytes: -999,
        },
      },
    }))};
    fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'turn-state.json'), JSON.stringify(state));
    const p = await import('./dist/persist.js');
    await p.loadTurnState();
    const ready = p.isTurnStateReady();
    if (ready) { console.error('FAIL: negative bytes must fail closed'); process.exit(2); }
    console.log('ok');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /ok/)
  rmSync(dir, { recursive: true, force: true })
}

async function testNegativeLedgerFailsClosed() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-persist-led-'))
  const { spawnSync } = await import('node:child_process')
  const script = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const state = ${JSON.stringify(baseTurnState({
      ipByteLedger: [{ ip: '9.9.9.9', bytes: -1, at: Date.now() }],
    }))};
    fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'turn-state.json'), JSON.stringify(state));
    const p = await import('./dist/persist.js');
    await p.loadTurnState();
    if (p.isTurnStateReady()) { console.error('FAIL ledger'); process.exit(2); }
    console.log('ok');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  rmSync(dir, { recursive: true, force: true })
}

async function testDurableDirSyncFailureRejects() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-persist-fsync-'))
  const { spawnSync } = await import('node:child_process')
  const script = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const p = await import('./dist/persist.js');
    await p.loadTurnState();
    p.markDirty();
    p._setDurableDirSyncHookForTest(async () => { throw Object.assign(new Error('injected dir sync fail'), { code: 'EIO' }); });
    let rejected = false;
    try {
      await p.flushTurnState(true);
    } catch {
      rejected = true;
    }
    p._setDurableDirSyncHookForTest(null);
    if (!rejected) { console.error('FAIL: durable flush must reject on parent fsync failure'); process.exit(2); }
    console.log('ok');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  rmSync(dir, { recursive: true, force: true })
}

async function testDurableDirSyncPlatformRefusalRejects() {
  // EPERM/EACCES/ENOTSUP used to be swallowed as success; strict flush must
  // reject so callers never authorize revoke/409/423 without durability.
  for (const code of ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'EISDIR']) {
    const dir = mkdtempSync(join(tmpdir(), `misaka-persist-${code}-`))
    const { spawnSync } = await import('node:child_process')
    const script = `
      process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
      process.env.TURN_AUTO_ENABLED = 'false';
      process.env.SERVER_SECRET = '11'.repeat(32);
      const p = await import('./dist/persist.js');
      await p.loadTurnState();
      p.markDirty();
      p._setDurableDirSyncHookForTest(async () => {
        throw Object.assign(new Error('platform refuse'), { code: ${JSON.stringify(code)} });
      });
      let rejected = false;
      try { await p.flushTurnState(true); } catch { rejected = true; }
      p._setDurableDirSyncHookForTest(null);
      if (!rejected) { console.error('FAIL: ' + ${JSON.stringify(code)} + ' must reject'); process.exit(2); }
      console.log('ok');
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, `${code}: ${r.stderr}${r.stdout}`)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testUnreadableLocksQuarantined() {
  const dir = mkdtempSync(join(tmpdir(), 'misaka-persist-lockq-'))
  const { spawnSync } = await import('node:child_process')
  const script = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const locksPath = path.join(${JSON.stringify(dir)}, 'auth-locks.json');
    fs.writeFileSync(locksPath, '{"version":1,"attemptLocks":[],"nodeFreezes":[]}');
    // Make unreadable
    fs.chmodSync(locksPath, 0);
    const p = await import('./dist/persist.js');
    await p.loadPersistedLocks();
    // Quarantine should have moved the file (or attempted to). On platforms
    // where chmod 0 still allows owner read, skip — but on Unix owner can
    // still read mode 0 files. Use a directory as the "file" to force EISDIR
    // or replace with a named pipe... Instead write then unlink and create a
    // directory with the same name so readFile fails with EISDIR.
  `
  // Simpler approach: write a directory named auth-locks.json
  const locksAsDir = join(dir, 'auth-locks.json')
  // remove if file, create dir
  try { rmSync(locksAsDir, { force: true }) } catch { /* */ }
  // write a file that fails JSON first? For unreadable: use a symlink to /dev/full or similar.
  // Actually the code path is readFile failure (not JSON). Create a directory.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(locksAsDir, { recursive: true })

  const script2 = `
    process.env.TURN_PERSIST_DIR = ${JSON.stringify(dir)};
    process.env.TURN_AUTO_ENABLED = 'false';
    process.env.SERVER_SECRET = '11'.repeat(32);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = await import('./dist/persist.js');
    await p.loadPersistedLocks();
    const entries = fs.readdirSync(${JSON.stringify(dir)});
    const q = entries.filter(e => e.startsWith('auth-locks.json.corrupt.'));
    if (q.length < 1) {
      // rename of a directory should still work
      console.error('FAIL: expected quarantine of unreadable locks, entries=', entries.join(','));
      process.exit(2);
    }
    const ready = p.isLocksStateReady();
    if (ready) { console.error('FAIL: locks must not be ready after unreadable load'); process.exit(2); }
    console.log('ok');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script2], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  rmSync(dir, { recursive: true, force: true })
}
