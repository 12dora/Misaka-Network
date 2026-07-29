#!/usr/bin/env node
/**
 * WebSocket auth path — Contract 3 close codes:
 *   4003 AUTH_EXPECTED / AUTH_TIMEOUT (transient)
 *   4001 INVALID_TOKEN (unknown)
 *   4002 SESSION_EXPIRED (expired)
 *
 * Usage: node tests/ws-auth.test.mjs
 */

import { WebSocket } from 'ws'
import { runTest, killChild, spawnTestServer } from './_harness.mjs'

runTest(main)

let BASE = ''
let WS_URL = ''
let serverProcess = null

async function main() {
  console.log('[1] 启动测试服务器...')
  const srv = await spawnTestServer({ MAX_NODES: '200' })
  serverProcess = srv.proc
  BASE = srv.base
  WS_URL = srv.wsUrl

  let failed = 0
  const cases = [
    ['non-AUTH first message → close 4003 AUTH_EXPECTED', testAuthRequired],
    ['unknown token → close 4001 INVALID_TOKEN',          testInvalidToken],
    ['valid token → WELCOME, no close',                   testValidAuth],
    ['malformed JSON before AUTH does not crash session', testMalformedBeforeAuth],
  ]

  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (e) {
      console.error(`  ✗ ${name}\n      ${e.stack || e.message}`)
      failed++
    }
  }

  await killChild(serverProcess)

  if (failed > 0) {
    console.error(`\n❌ ${failed} 用例失败`)
    process.exitCode = 1
    return
  }
  console.log('\n✅ 全部测试通过')
}

async function testAuthRequired() {
  const ws = await openWS()
  ws.send(JSON.stringify({ t: 'PING' }))
  const closure = await waitForClose(ws, 2000)
  assertEq(closure.code, 4003, '关闭码应为 4003 AUTH_EXPECTED')
}

async function testInvalidToken() {
  const ws = await openWS()
  ws.send(JSON.stringify({ t: 'AUTH', token: 'definitely-not-a-real-token' }))
  const closure = await waitForClose(ws, 2000)
  assertEq(closure.code, 4001, '关闭码应为 4001 INVALID_TOKEN')
}

async function testValidAuth() {
  const reg = await post('/register', { nodeId: 14010, passCode: '424242' })
  if (!reg.token) throw new Error('register 失败')

  const ws = await openWS()
  const closedPromise = waitForClose(ws, 1500).catch(() => null)
  const messages = []
  ws.on('message', raw => {
    try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })

  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))

  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 1500)
  assertEq(welcome.sessionId, reg.sessionId, 'WELCOME sessionId 应与 register 一致')

  const racedClose = await Promise.race([
    closedPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 200)),
  ])
  if (racedClose) throw new Error(`Auth 成功后不应关闭，却收到 close code=${racedClose.code}`)

  ws.close()
}

async function testMalformedBeforeAuth() {
  const reg = await post('/register', { nodeId: 14011, passCode: '101010' })
  const ws = await openWS()
  const messages = []
  ws.on('message', raw => {
    try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
  })

  ws.send('not-json-at-all')
  ws.send(JSON.stringify({ t: 'WHO_KNOWS' }))
  ws.send(JSON.stringify({ t: 'AUTH', token: reg.token }))

  const welcome = await waitFor(() => messages.find(m => m.t === 'WELCOME'), 1500)
  assertEq(welcome.t, 'WELCOME', '畸形消息不应阻止后续 AUTH')
  ws.close()
}

function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitForClose(ws, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`未在 ${ms}ms 内收到 close`)), ms)
    ws.once('close', (code, reason) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString() })
    })
  })
}

async function waitFor(probe, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = probe()
    if (v) return v
    await sleep(50)
  }
  throw new Error(`waitFor 超时 (${ms}ms)`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: 期望 ${expected}, 实际 ${actual}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
