// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ACGN from '../../src/pages/ACGN'

describe('A11Y-002: small text on cards uses a readable palette token', () => {
  it('does not render the low-contrast cyan token for timeline/about text', () => {
    const container = document.createElement('div')
    act(() => createRoot(container).render(<MemoryRouter><ACGN /></MemoryRouter>))

    const timelineDate = container.querySelector('#timeline .font-mono')
    expect(timelineDate?.className).toContain('text-[var(--bg-deep)]')
    for (const label of ['脑量子波', '实验体', '分布式']) {
      const element = [...container.querySelectorAll('span')].find(node => node.textContent === label)
      expect(element?.getAttribute('style')).toContain('--bg-deep')
      expect(element?.getAttribute('style')).not.toContain('--accent-cyan')
    }
  })
})
