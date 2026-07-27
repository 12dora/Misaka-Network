// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import Privacy from '../../src/pages/Privacy'
import Terms from '../../src/pages/Terms'

describe('UX-COPY-001: legal copy matches deployed behavior', () => {
  it('discloses durable security state, IP logs, and third-party TURN metadata', () => {
    const container = document.createElement('div')
    act(() => createRoot(container).render(<MemoryRouter><Privacy /></MemoryRouter>))
    expect(container.textContent).toMatch(/暴力破解锁会持久化/)
    expect(container.textContent).toMatch(/来源 IP/)
    expect(container.textContent).toMatch(/Cloudflare Realtime TURN/)
    expect(container.textContent).toMatch(/网络元数据/)
  })

  it('does not promise that all service-side data disappears with a session', () => {
    const container = document.createElement('div')
    act(() => createRoot(container).render(<MemoryRouter><Terms /></MemoryRouter>))
    expect(container.textContent).toMatch(/TURN 额度\/撤销状态和暴力破解锁会持久化/)
    expect(container.textContent).not.toMatch(/所有服务器数据仅存在于内存/)
  })
})
