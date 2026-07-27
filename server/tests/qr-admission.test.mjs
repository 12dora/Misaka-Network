#!/usr/bin/env node
/**
 * SECURITY-011 / BUG-003:
 * - creating an invite is an authenticated POST and never puts the passcode
 *   in the URL;
 * - redeeming produces a short-lived admission grant but does not consume the
 *   one-time invite;
 * - the grant is committed by /register, and a failed admission may retry.
 */

import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { killChild, runTest, spawn } from './_harness.mjs'

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 19034
const BASE = `http://127.0.0.1:${PORT}/api`
let serverProcess

runTest(main)

async function main() {
  serverProcess = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      TRUST_PROXY: '1',
      TURN_AUTO_ENABLED: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stderr.pipe(process.stderr)
  await waitForServer()

  try {
    const owner = await register(17300, '173000', '203.0.113.70')
    for (let i = 0; i < 9; i++) {
      const extra = await register(17300, '173000', '203.0.113.70')
      assert(extra.token, `filled same-IP slot ${i + 2}`)
    }

    const legacy = await fetch(`${BASE}/qr-token?passCode=173000`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assertEq(legacy.status, 404, 'legacy GET route must not create invites')

    const created = await fetch(`${BASE}/qr-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assertEq(created.status, 200, 'authenticated POST creates invite')
    assertEq(created.headers.get('cache-control'), 'no-store', 'invite response is not cacheable')
    const invite = await created.json()
    assert(invite.qrToken, 'invite contains qrToken')

    const redeemed = await fetch(`${BASE}/qr-redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.70' },
      body: JSON.stringify({ qrToken: invite.qrToken, myNodeId: 17300, myPassCode: '173000' }),
    })
    assertEq(redeemed.status, 200, 'correct passcode produces an admission grant')
    assertEq(redeemed.headers.get('cache-control'), 'no-store', 'grant response is not cacheable')
    const grant = await redeemed.json()
    assert(grant.admissionGrant, 'redeem response contains an admission grant')

    // Same IP is full because the owner already occupies its only slot. The
    // failed register must not burn either the grant or the invitation.
    const denied = await register(17300, '173000', '203.0.113.70', grant.admissionGrant)
    assertEq(denied.error, 'IP_LIMITED', 'admission can fail before commit')

    const redeemedAgain = await fetch(`${BASE}/qr-redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.70' },
      body: JSON.stringify({ qrToken: invite.qrToken, myNodeId: 17300, myPassCode: '173000' }),
    })
    assertEq(redeemedAgain.status, 200, 'failed admission leaves invite retryable')
    const sameGrant = await redeemedAgain.json()
    assertEq(sameGrant.admissionGrant, grant.admissionGrant, 'redeem is idempotent for the same invite')

    const accepted = await register(17300, '173000', '198.51.100.70', grant.admissionGrant)
    assert(accepted.token, 'grant commits with successful registration')

    const consumed = await fetch(`${BASE}/qr-redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.70' },
      body: JSON.stringify({ qrToken: invite.qrToken, myNodeId: 17300, myPassCode: '173000' }),
    })
    assertEq(consumed.status, 400, 'committed invite is single-use')

    console.log('✅ QR admission transaction tests passed')
  } finally {
    killChild(serverProcess)
  }
}

async function register(nodeId, passCode, ip, admissionGrant) {
  const response = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ nodeId, passCode, ...(admissionGrant ? { admissionGrant } : {}) }),
  })
  return response.json()
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (serverProcess.exitCode !== null) throw new Error(`server exited early (${serverProcess.exitCode})`)
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) return
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('server startup timeout')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
