// 07 P2 — UserFacingErrorCode → action-oriented zh-CN messages.
//
// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  toUserMessage,
  classifyError,
  toUserMessageFromUnknown,
  type UserFacingErrorCode,
} from '../../src/copy/errors'
import { titleForPath } from '../../src/copy/zh-CN/pageMeta'
import { formatDurationZhCN, formatRange } from '../../src/copy/zh-CN/common'
import { auth } from '../../src/copy/zh-CN/auth'

describe('copy/errors mapping', () => {
  const codes: UserFacingErrorCode[] = [
    'storage-full',
    'connection-lost',
    'encryption-failed',
    'rate-limited',
    'session-expired',
    'generic-failure',
  ]

  it.each(codes)('%s maps to a non-empty action-oriented zh-CN string', (code) => {
    const msg = toUserMessage(code)
    expect(msg.length).toBeGreaterThan(4)
    expect(msg).not.toMatch(/Error:|HTTP \d+|crypto worker/i)
  })

  it('storage-full can interpolate a file name', () => {
    expect(toUserMessage('storage-full', { fileName: 'a.bin' })).toContain('a.bin')
  })

  it('classifies quota / 429 / crypto / disconnect heuristics', () => {
    expect(classifyError('STORAGE_QUOTA_EXCEEDED')).toBe('storage-full')
    expect(classifyError('HTTP 429')).toBe('rate-limited')
    expect(classifyError('crypto worker crashed')).toBe('encryption-failed')
    expect(classifyError('connection lost')).toBe('connection-lost')
    expect(classifyError('session expired')).toBe('session-expired')
  })

  it('toUserMessageFromUnknown never returns raw English stacks for known codes', () => {
    expect(toUserMessageFromUnknown('STORAGE_QUOTA_EXCEEDED')).toMatch(/存储/)
  })
})

describe('copy/pageMeta + duration', () => {
  it('returns distinct titles per route', () => {
    expect(titleForPath('/network')).toContain('网络')
    expect(titleForPath('/privacy')).toContain('隐私')
    expect(titleForPath('/tos')).toContain('服务条款')
    expect(titleForPath('/unknown')).toBe('御坂网络')
  })

  it('formats Chinese durations and ranges', () => {
    expect(formatDurationZhCN(65_000)).toBe('1 分钟 5 秒')
    expect(formatRange(1, 20001)).toBe('1–20001')
  })

  it('session renewal copy matches Contract 2 wording', () => {
    expect(auth.sessionRenewalHint).toBe('会话在持续使用时自动续期，闲置约 30 分钟后释放')
  })
})
