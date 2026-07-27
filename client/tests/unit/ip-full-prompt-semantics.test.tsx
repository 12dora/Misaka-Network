// UX-COPY-002: IP quota recovery is identity-scoped. It must never claim to
// destroy every node on the IP, and the server's actual released count must
// be visible, including the important zero-result edge.
//
// @vitest-environment jsdom

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IpFullPrompt from '../../src/components/features/IpFullPrompt'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
})

async function renderAndConfirm(released: number) {
  const onConfirm = vi.fn(async () => released)
  await act(async () => {
    root.render(<IpFullPrompt onConfirm={onConfirm} onCancel={() => {}} />)
  })
  expect(document.body.textContent).not.toContain('所有已注册节点')
  const button = Array.from(document.querySelectorAll('button'))
    .find(el => el.textContent?.includes('释放同一身份'))
  expect(button).toBeTruthy()
  await act(async () => { button?.click() })
  return onConfirm
}

describe('UX-COPY-002 identity-scoped recovery', () => {
  it('surfaces zero explicitly and does not claim a retry happened', async () => {
    const onConfirm = await renderAndConfirm(0)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('未释放任何节点')
    expect(document.body.textContent).toContain('没有自动重试')
  })

  it('surfaces the actual released count', async () => {
    await renderAndConfirm(2)
    expect(document.body.textContent).toContain('已释放同一身份的 2 个节点')
  })
})
