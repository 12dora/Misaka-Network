#!/usr/bin/env node
/**
 * Occupied wrong-passcode path must run scrypt (verifyAndMaybeUpgrade), not
 * HMAC-only identity compare.
 */
import assert from 'node:assert/strict'
import { runTest } from './_harness.mjs'

runTest(main)

async function main() {
  const store = await import('../dist/store.js')
  store._resetScryptInvokeCountForTest()

  const rec = await store.newPassCodeRecord('424242')
  assert.equal(rec.passCodeAlgo, 'scrypt')

  const before = store._scryptInvokeCountForTest
  // newPassCodeRecord already used scrypt once.
  assert.ok(before >= 1)

  const wrong = await store.verifyAndMaybeUpgrade('000000', rec)
  assert.equal(wrong.ok, false)
  assert.ok(
    store._scryptInvokeCountForTest > before,
    `wrong passcode against scrypt record must invoke scrypt (before=${before}, after=${store._scryptInvokeCountForTest})`,
  )

  // Legacy HMAC-only record still rejects without upgrading on wrong code.
  const legacy = { passCodeHash: store.hashPassCodeIdentity('424242') }
  const beforeLegacy = store._scryptInvokeCountForTest
  const wrongLegacy = await store.verifyAndMaybeUpgrade('000000', legacy)
  assert.equal(wrongLegacy.ok, false)
  assert.equal(
    store._scryptInvokeCountForTest,
    beforeLegacy,
    'wrong passcode on legacy record must not run scrypt',
  )

  console.log('✅ occupied wrong-passcode scrypt path tests passed')
}
