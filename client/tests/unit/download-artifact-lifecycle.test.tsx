// OPFS downloads are lazy. A fixed delay cannot prove browser consumption
// finished, so the component must retain storage for an arbitrarily slow
// download and release it only after explicit user acknowledgement.
//
// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { markStarted, release } = vi.hoisted(() => ({
  markStarted: vi.fn(),
  release: vi.fn(async () => {}),
}))

vi.mock('@/store/network', () => ({
  markDownloadArtifactStarted: markStarted,
  releaseDownloadArtifact: release,
  isDownloadArtifactStarted: () => false,
}))

import DownloadArtifactActions from '../../src/components/features/DownloadArtifactActions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  markStarted.mockClear()
  release.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('OPFS download retention lifecycle', () => {
  it('does not release a slow lazy artefact on any fixed timer', async () => {
    act(() => {
      root.render(<DownloadArtifactActions id="large" url="blob:lazy-opfs" fileName="large.bin" />)
    })

    const download = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('下载'))
    act(() => download?.click())

    expect(markStarted).toHaveBeenCalledWith('blob:lazy-opfs')
    // Model a very large/slow browser consumer: even ten minutes after the
    // click there is no observable completion event and cleanup must not run.
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(release).not.toHaveBeenCalled()

    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="release-download-large"]')
    await act(async () => { confirm?.click(); await Promise.resolve() })
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('blob:lazy-opfs')
    expect(container.textContent).toContain('临时副本已释放')
  })
})
