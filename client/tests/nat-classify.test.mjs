#!/usr/bin/env node
/**
 * NAT 分类逻辑测试（纯函数）
 *
 * 测试 src/lib/nat.ts 中的 parseCandidate / classifyNat / isPrivateAddress
 * 在不依赖浏览器 RTCPeerConnection 的情况下能否正确判定 NAT 类型。
 *
 * 通过 tsx 直接加载 TS 源码，避免引入 Jest/Vitest 等测试框架。
 *
 * Usage: cd client && npx tsx tests/nat-classify.test.mjs
 */

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

// Load the pure-logic TS file through tsx's loader (this script runs via
// `npx tsx`). nat-classify.ts has no `@/` aliases or DOM globals, so it
// loads cleanly in plain Node.
const modulePath = resolve(projectRoot, 'src/lib/nat-classify.ts')
const { parseCandidate, classifyNat, isPrivateAddress } = await import(modulePath)

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`)
    failed++
  }
}

function assertEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}\n      期望: ${e}\n      实际: ${a}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── parseCandidate ───────────────────────────────────────────────────

console.log('\n[1] parseCandidate')

test('解析典型的 srflx 候选', () => {
  const line = 'candidate:842163049 1 udp 1677729535 1.2.3.4 51234 typ srflx raddr 192.168.1.10 rport 56789'
  const c = parseCandidate(line)
  assertEq(c, {
    type: 'srflx', protocol: 'udp',
    address: '1.2.3.4', port: 51234,
    relatedAddress: '192.168.1.10', relatedPort: 56789,
  })
})

test('解析无 candidate: 前缀的候选', () => {
  const c = parseCandidate('1 1 udp 2122260223 192.168.1.5 54321 typ host')
  assertEq(c, { type: 'host', protocol: 'udp', address: '192.168.1.5', port: 54321 })
})

test('解析 relay 候选', () => {
  const c = parseCandidate('candidate:1 1 udp 41885439 5.6.7.8 49160 typ relay raddr 1.2.3.4 rport 51234')
  assertEq(c?.type, 'relay')
  assertEq(c?.address, '5.6.7.8')
})

test('拒绝畸形输入', () => {
  assertEq(parseCandidate(''), null)
  assertEq(parseCandidate('garbage'), null)
  assertEq(parseCandidate('candidate:1 1 udp'), null)
})

test('拒绝未知协议或类型', () => {
  assertEq(parseCandidate('1 1 sctp 100 1.2.3.4 5 typ host'), null)
  assertEq(parseCandidate('1 1 udp 100 1.2.3.4 5 typ wibble'), null)
})

// ── isPrivateAddress ─────────────────────────────────────────────────

console.log('\n[2] isPrivateAddress')

test('识别 RFC1918 私网', () => {
  assert(isPrivateAddress('10.0.0.1'), '10/8 应为私网')
  assert(isPrivateAddress('192.168.1.1'), '192.168/16 应为私网')
  assert(isPrivateAddress('172.20.0.1'), '172.16/12 应为私网')
  assert(isPrivateAddress('127.0.0.1'), '环回应为私网')
  assert(isPrivateAddress('169.254.1.1'), 'link-local 应为私网')
})

test('识别 CGNAT 100.64/10', () => {
  assert(isPrivateAddress('100.64.0.1'), 'CGNAT 应为私网')
  assert(isPrivateAddress('100.127.255.255'), 'CGNAT 末端')
  assert(!isPrivateAddress('100.63.0.1'), '100.63 不是 CGNAT')
  assert(!isPrivateAddress('100.128.0.1'), '100.128 不是 CGNAT')
})

test('识别 mDNS .local', () => {
  assert(isPrivateAddress('abc-def.local'), '.local 应为私网')
})

test('公网地址不被误判', () => {
  assert(!isPrivateAddress('1.2.3.4'), '1.2.3.4 是公网')
  assert(!isPrivateAddress('8.8.8.8'), '8.8.8.8 是公网')
  assert(!isPrivateAddress('114.114.114.114'), '114.114.114.114 是公网')
})

test('IPv6 私网识别', () => {
  assert(isPrivateAddress('::1'), 'IPv6 环回')
  assert(isPrivateAddress('fe80::1'), 'IPv6 link-local')
  assert(isPrivateAddress('fc00::1'), 'IPv6 ULA')
  assert(!isPrivateAddress('2001:db8::1'), '文档地址不算私网（这里允许）')
})

// ── classifyNat ──────────────────────────────────────────────────────

console.log('\n[3] classifyNat')

test('无候选 → blocked', () => {
  const r = classifyNat([])
  assertEq(r.type, 'blocked')
})

test('只有 host 但无 srflx → blocked', () => {
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: '192.168.1.5', port: 50000 },
  ])
  assertEq(r.type, 'blocked')
  assert(r.hasHostCandidate, 'hasHostCandidate 应为真')
})

test('host 是公网地址 → open', () => {
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: '1.2.3.4', port: 50000 },
  ])
  assertEq(r.type, 'open')
})

test('mDNS host 不算 open', () => {
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: 'abc.local', port: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
  ])
  assertEq(r.type, 'cone')
})

test('多个 STUN 同一公网映射 → cone NAT', () => {
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: '192.168.1.10', port: 50000 },
    // 两个不同 STUN 服务器对同一本地端口都报告同一公网映射
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
  ])
  assertEq(r.type, 'cone')
  assertEq(r.publicEndpoints, ['1.2.3.4:60000'])
})

test('同一本地端口被映射到多个公网端口 → 对称 NAT', () => {
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: '192.168.1.10', port: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60001,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
  ])
  assertEq(r.type, 'symmetric')
  assert(r.publicEndpoints.length === 2, '应记录 2 个公网映射')
})

test('多本地端口、各自一致 → 仍判为 cone', () => {
  // 模拟浏览器使用 iceCandidatePoolSize 时多个本地 socket
  const r = classifyNat([
    { type: 'host', protocol: 'udp', address: '192.168.1.10', port: 50000 },
    { type: 'host', protocol: 'udp', address: '192.168.1.10', port: 50001 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60000,
      relatedAddress: '192.168.1.10', relatedPort: 50000 },
    { type: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 60001,
      relatedAddress: '192.168.1.10', relatedPort: 50001 },
  ])
  assertEq(r.type, 'cone')
})

// ── 解析 + 分类整合 ──────────────────────────────────────────────────

console.log('\n[4] 解析 + 分类整合')

test('从 SDP 行整体走通分类流程', () => {
  const lines = [
    'candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host',
    'candidate:2 1 udp 1677729535 1.2.3.4 60000 typ srflx raddr 192.168.1.10 rport 50000',
    'candidate:3 1 udp 1677729535 1.2.3.4 60001 typ srflx raddr 192.168.1.10 rport 50000',
  ]
  const parsed = lines.map(parseCandidate).filter(Boolean)
  const r = classifyNat(parsed)
  assertEq(r.type, 'symmetric')
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
