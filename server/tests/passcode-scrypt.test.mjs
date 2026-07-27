#!/usr/bin/env node
/**
 * P0-2: scrypt hashing + per-session salt + legacy sha256 migration.
 *
 * We exercise the store helpers directly because the rest of the test
 * suite already covers the HTTP-level passcode flow end-to-end. The unit
 * shape here pins three invariants the rest of the code relies on:
 *
 *   - hashPassCodeScrypt(code, saltA) !== hashPassCodeScrypt(code, saltB)
 *     (all three helpers are async now — scrypt runs on the libuv threadpool
 *     behind a bounded semaphore instead of blocking the event loop.)
 *     i.e. salts ARE used. Without this, a stolen dump of one node's hash
 *     could be replayed against every other node's hash.
 *   - newPassCodeRecord returns BOTH a deterministic sha256 identity hash
 *     AND a per-call scrypt verify hash; the same plaintext registered
 *     twice gets the same identity hash (cluster routing relies on this)
 *     but different verify hashes (per-session salt).
 *   - verifyAndMaybeUpgrade accepts a legacy { passCodeHash: sha256(code) }
 *     shape, returns ok=true, and emits the scrypt-upgraded fields in
 *     `upgrade` so the caller can persist the upgrade.
 */

import { runTest } from './_harness.mjs'
import assert from 'node:assert/strict'

runTest(main, { timeoutMs: 30_000 })

async function main() {
  const {
    hashPassCodeIdentity,
    hashPassCodeScrypt,
    newPassCodeSalt,
    newPassCodeRecord,
    verifyAndMaybeUpgrade,
  } = await import('../dist/store.js')

  console.log('[1] scrypt with different salts produces different digests')
  const saltA = newPassCodeSalt()
  const saltB = newPassCodeSalt()
  assert.notEqual(saltA, saltB)
  const code = '654321'
  const dA = await hashPassCodeScrypt(code, saltA)
  const dB = await hashPassCodeScrypt(code, saltB)
  assert.notEqual(dA, dB, 'same plaintext + different salt → different scrypt digest')
  assert.equal(dA, await hashPassCodeScrypt(code, saltA), 'scrypt is deterministic for (code, salt)')
  console.log('  ✓ scrypt 不同 salt 产生不同结果，相同 (code, salt) 稳定')

  console.log('[2] newPassCodeRecord: identity hash deterministic, verify hash unique per call')
  const rec1 = await newPassCodeRecord(code)
  const rec2 = await newPassCodeRecord(code)
  assert.equal(rec1.passCodeHash, rec2.passCodeHash, '同 plaintext 的 identity hash 必须一致 (cluster 依赖)')
  assert.notEqual(rec1.passCodeSalt, rec2.passCodeSalt, 'salt 应每次新生成')
  assert.notEqual(rec1.passCodeVerifyHash, rec2.passCodeVerifyHash, 'verify hash 应每次不同')
  assert.equal(rec1.passCodeAlgo, 'scrypt')
  console.log('  ✓ identity hash 确定性 / verify hash 每次唯一')

  console.log('[3] verifyAndMaybeUpgrade: scrypt path returns ok with no upgrade')
  const ok = await verifyAndMaybeUpgrade(code, rec1)
  assert.equal(ok.ok, true, '正确 plaintext 应通过')
  assert.equal(ok.upgrade, undefined, 'scrypt 会话无需 upgrade')
  const bad = await verifyAndMaybeUpgrade('999999', rec1)
  assert.equal(bad.ok, false, '错误 plaintext 应被拒')
  console.log('  ✓ scrypt 路径正确接受/拒绝')

  console.log('[4] verifyAndMaybeUpgrade: legacy sha256 path returns ok + upgrade')
  // Legacy shape: ONLY the sha256 identity hash; no salt, no verify hash.
  const legacy = { passCodeHash: hashPassCodeIdentity(code) }
  const upgraded = await verifyAndMaybeUpgrade(code, legacy)
  assert.equal(upgraded.ok, true, '老 sha256 hash 在首次校验时应通过')
  assert.ok(upgraded.upgrade, 'upgrade 字段必须返回，让 caller 持久化')
  assert.equal(upgraded.upgrade.passCodeAlgo, 'scrypt')
  assert.ok(upgraded.upgrade.passCodeSalt && upgraded.upgrade.passCodeSalt.length === 32, 'salt 32 hex chars (16 bytes)')
  assert.ok(upgraded.upgrade.passCodeVerifyHash, 'verify hash 已生成')
  // Identity hash unchanged — that's the point.
  assert.equal(upgraded.upgrade.passCodeHash, legacy.passCodeHash, 'identity hash 不应在 upgrade 时改变')

  // 应用 upgrade 后下一次校验走 scrypt 路径，不再返回 upgrade。
  const stored = { ...legacy, ...upgraded.upgrade }
  const second = await verifyAndMaybeUpgrade(code, stored)
  assert.equal(second.ok, true)
  assert.equal(second.upgrade, undefined, '已 upgrade 的会话不应再次 upgrade')
  console.log('  ✓ 老 sha256 → scrypt 一次性迁移')

  console.log('[5] verifyAndMaybeUpgrade: legacy path rejects wrong passcode and returns no upgrade')
  const wrong = await verifyAndMaybeUpgrade('111111', legacy)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.upgrade, undefined, '错误 passcode 不应触发 upgrade — 否则攻击者一次失败也能把会话从 sha256 推到 scrypt')
  console.log('  ✓ 错误 plaintext 不会触发 upgrade')

  console.log('\n✅ 全部测试通过')
}
