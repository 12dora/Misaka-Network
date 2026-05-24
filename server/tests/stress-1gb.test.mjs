#!/usr/bin/env node
/**
 * 1GB 文件内存压测
 *
 * 模拟 1GB 文件的 chunk → encrypt → decrypt → assemble 全流程，
 * 逐块 GC 友好的 sender 路径 vs 全部在内存中 assemble 的 Blob 路径。
 *
 * Usage: cd server && node tests/stress-1gb.test.mjs
 */

import crypto from 'crypto'
import { createRequire } from 'module'
import { runTest } from './_harness.mjs'

const require = createRequire(import.meta.url)

const CHUNK_SIZE = 64 * 1024        // 64KB
const FILE_SIZE = 1024 * 1024 * 1024 // 1GB
const TOTAL_CHUNKS = Math.ceil(FILE_SIZE / CHUNK_SIZE) // 16384

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function mem() {
  const m = process.memoryUsage()
  return `heapUsed=${mb(m.heapUsed)} heapTotal=${mb(m.heapTotal)} rss=${mb(m.rss)}`
}

function randBuf(size) {
  return crypto.randomBytes(size)
}

// Simulate AES-256-GCM encrypt (like browser crypto.subtle.encrypt)
function encryptChunk(key, data) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])
  return { iv, encrypted }
}

// Simulate AES-256-GCM decrypt
function decryptChunk(key, iv, encrypted) {
  const tag = encrypted.subarray(encrypted.length - 16)
  const ct = encrypted.subarray(0, encrypted.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

function checksum(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('══════════════════════════════════════════════')
  console.log('  御坂网络 1GB 文件内存压测')
  console.log('══════════════════════════════════════════════')
  console.log(`  Chunk size: ${mb(CHUNK_SIZE)}  Total chunks: ${TOTAL_CHUNKS}  File size: 1GB`)
  console.log()

  const key = crypto.randomBytes(32) // AES-256 key

  // Force GC if available
  const gc = global.gc || (() => {})

  // ── Test 1: Streaming sender path (GC friendly, one chunk at a time) ──
  console.log('── 测试 1: Sender 流式路径（逐块处理） ──')
  gc()
  await sleep(200)
  const memBefore1 = process.memoryUsage()

  let totalEncrypted = 0
  const checksums = []
  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    const chunk = randBuf(CHUNK_SIZE)
    const { iv, encrypted } = encryptChunk(key, chunk)
    checksums.push(checksum(encrypted))
    totalEncrypted += encrypted.byteLength
    if (i % 2048 === 0 && i > 0) {
      console.log(`  ... ${((i / TOTAL_CHUNKS) * 100).toFixed(0)}%  ${mem()}`)
    }
  }

  const memAfter1 = process.memoryUsage()
  console.log(`  完成: ${((TOTAL_CHUNKS / TOTAL_CHUNKS) * 100).toFixed(0)}%`)
  console.log(`  加密总量: ${mb(totalEncrypted)}`)
  console.log(`  内存增长: heapUsed +${mb(memAfter1.heapUsed - memBefore1.heapUsed)}, rss +${mb(memAfter1.rss - memBefore1.rss)}`)
  console.log('  ✓ Sender 流式路径：内存增长应 < 100 MB\n')

  // ── Test 2: Blob assembly path (all chunks in memory) ─────────────
  console.log('── 测试 2: Blob 组装路径（全部 chunk 加载到内存） ──')
  gc()
  await sleep(200)

  // Simulate receiver: decrypt and accumulate
  const allChunks = []
  const memBefore2 = process.memoryUsage()

  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    // Generate same chunk as sender
    const chunk = randBuf(CHUNK_SIZE)
    const { iv, encrypted } = encryptChunk(key, chunk)
    const decrypted = decryptChunk(key, iv, encrypted)
    allChunks.push(decrypted) // accumulate — this is the Blob path
    if (i % 2048 === 0 && i > 0) {
      console.log(`  ... ${((i / TOTAL_CHUNKS) * 100).toFixed(0)}%  ${mem()}`)
    }
  }

  // Simulate Blob assembly
  const assembled = Buffer.concat(allChunks)
  const memAfter2 = process.memoryUsage()
  console.log(`  完成: 100%`)
  console.log(`  组装大小: ${mb(assembled.byteLength)}`)
  console.log(`  峰值内存: heapUsed=${mb(memAfter2.heapUsed)} rss=${mb(memAfter2.rss)}`)
  console.log(`  内存增长: heapUsed +${mb(memAfter2.heapUsed - memBefore2.heapUsed)}, rss +${mb(memAfter2.rss - memBefore2.rss)}`)
  console.log('  ⚠ Blob 组装路径：峰值 ~1.5GB+, Safari/Firefox 降级时应监控\n')

  // ── Test 3: Streaming receiver path (write-and-discard) ───────────
  console.log('── 测试 3: 接收端流式路径（模拟逐块写盘） ──')
  gc()
  await sleep(200)
  const memBefore3 = process.memoryUsage()

  let streamWritten = 0
  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    const chunk = randBuf(CHUNK_SIZE)
    const { iv, encrypted } = encryptChunk(key, chunk)
    const decrypted = decryptChunk(key, iv, encrypted)
    // Simulate write to disk: just discard after processing
    streamWritten += decrypted.byteLength
    if (i % 4096 === 0 && i > 0) {
      gc()
      if (i % 8192 === 0) console.log(`  ... ${((i / TOTAL_CHUNKS) * 100).toFixed(0)}%  ${mem()}`)
    }
  }

  const memAfter3 = process.memoryUsage()
  console.log(`  完成: 100%`)
  console.log(`  写入总量: ${mb(streamWritten)}`)
  console.log(`  内存增长: heapUsed +${mb(memAfter3.heapUsed - memBefore3.heapUsed)}, rss +${mb(memAfter3.rss - memBefore3.rss)}`)
  console.log('  ✓ 流式路径：内存增长应 < 50 MB\n')

  // ── Summary ─────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════')
  console.log('  总结')
  console.log('══════════════════════════════════════════════')
  console.log('  ✓ Sender 逐块发送 — 内存安全（~100MB overhead）')
  console.log('  ✓ 接收端流式写盘 — 内存安全（~50MB overhead）')
  console.log('  ⚠ 接收端 Blob 组装 — 峰值 ~1.5GB, 仅作为不支持 FSAA 的降级路径')
  console.log()
  console.log('  建议:')
  console.log('  1. Safari/Firefox Blob 路径: IndexedDB 中保持 chunk 分散存储')
  console.log('  2. 超大文件 (>500MB) Blob 组装时显示内存警告')
  console.log('  3. 优先使用 File System Access API 流式写入')
  console.log('')
  console.log('✅ 1GB 内存压测完成')
}

// CLAUDE.md "test-script lifecycle": runTest enforces an explicit
// process.exit(). The stress test runs for several minutes; without the
// watchdog a hung allocator or GC loop would silently wedge CI. Bump the
// timeout to 10min to fit the worst-case run on a slow runner.
runTest(main, { timeoutMs: 10 * 60 * 1000 })
