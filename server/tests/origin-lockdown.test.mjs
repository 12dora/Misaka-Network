#!/usr/bin/env node
/**
 * ALLOWED_ORIGINS= (explicit empty) must total-lockdown browser Origins —
 * including same-origin Host matches. Non-browser (no Origin) still passes.
 * Also: X-Forwarded-Proto is ignored when TRUST_PROXY is off.
 */
import assert from 'node:assert/strict'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

async function main() {
  await testEmptyLockdownUnit()
  await testEmptyLockdownHttp()
  await testForwardedProtoTrustBoundary()
  await testForwardedProtoCidrBoundary()
  console.log('✅ origin lockdown + scheme trust-boundary tests passed')
}

async function testEmptyLockdownUnit() {
  process.env.ALLOWED_ORIGINS = ''
  const origin = await import('../dist/origin.js')
  origin._resetAllowedOriginsCache()
  assert.deepEqual(origin.allowedOrigins(), [])
  assert.equal(origin.isWildcardOriginMode(), false)

  const sameOriginReq = {
    headers: {
      origin: 'http://localhost:9080',
      host: 'localhost:9080',
    },
    secure: false,
  }
  assert.equal(
    origin.isHttpOriginAllowed(sameOriginReq),
    false,
    'empty lockdown must refuse same-origin browser Origin',
  )
  assert.equal(
    origin.isOriginAllowedForRequest(sameOriginReq),
    false,
    'empty lockdown must refuse same-origin for WS path too',
  )
  assert.equal(
    origin.isHttpOriginAllowed({ headers: {} }),
    true,
    'non-browser (no Origin) still allowed',
  )
  delete process.env.ALLOWED_ORIGINS
  origin._resetAllowedOriginsCache()
}

async function testEmptyLockdownHttp() {
  const { proc, base, port } = await spawnTestServer({
    ALLOWED_ORIGINS: '',
  })
  try {
    const host = `127.0.0.1:${port}`
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://${host}`,
        Host: host,
      },
      body: JSON.stringify({ nodeId: 18001, passCode: '111111' }),
    })
    assert.equal(res.status, 403, `same-origin under empty lockdown must 403, got ${res.status}`)
    const body = await res.json()
    assert.equal(body.error, 'BAD_ORIGIN')

    // No Origin still works.
    const ok = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 18002, passCode: '222222' }),
    })
    assert.equal(ok.status, 200, 'non-browser register must still work')
  } finally {
    await killChild(proc)
  }
}

async function testForwardedProtoTrustBoundary() {
  // Direct HTTP with spoofed X-Forwarded-Proto:https must NOT make
  // Origin: https://host pass when TRUST_PROXY is off.
  const { proc, base, port } = await spawnTestServer({
    ALLOWED_ORIGINS: 'https://app.example.com',
    // TRUST_PROXY unset → off
  })
  try {
    const host = `127.0.0.1:${port}`
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `https://${host}`,
        Host: host,
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ nodeId: 18003, passCode: '333333' }),
    })
    assert.equal(
      res.status,
      403,
      `spoofed X-Forwarded-Proto must not unlock cross-scheme Origin, got ${res.status}`,
    )
  } finally {
    await killChild(proc)
  }
}

async function testForwardedProtoCidrBoundary() {
  // TRUST_PROXY is ON (a CIDR policy), but the direct peer is loopback which
  // is OUTSIDE 10.0.0.0/8. X-Forwarded-Proto must still be ignored — this is
  // the case the TRUST_PROXY_ENABLED-only check gets wrong.
  const { proc, base, port } = await spawnTestServer({
    ALLOWED_ORIGINS: 'https://app.example.com',
    TRUST_PROXY: '10.0.0.0/8',
  })
  try {
    const host = `127.0.0.1:${port}`
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `https://${host}`,
        Host: host,
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ nodeId: 18004, passCode: '444444' }),
    })
    assert.equal(
      res.status,
      403,
      `CIDR trust policy must not honour XFP from untrusted peer, got ${res.status}`,
    )
  } finally {
    await killChild(proc)
  }
}
