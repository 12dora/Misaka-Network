import { describe, expect, it, vi } from 'vitest'
import { assertE2eBackend } from '../e2e/helpers'

describe('E2E backend readiness guard', () => {
  it('retries a transient connection reset before accepting the compatible backend', async () => {
    vi.useFakeTimers()
    const get = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({
        status: () => 200,
        json: async () => ({
          ready: true,
          turnState: 'ready',
          locksState: 'ready',
          e2eBuildNonce: 'misaka-playwright-v1',
        }),
      })

    const assertion = assertE2eBackend({ get } as never)
    await vi.runAllTimersAsync()
    await expect(assertion).resolves.toBeUndefined()
    expect(get).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
