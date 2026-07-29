// 07 P2 — document.title must follow the router via the real App PageTitle.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { titleForPath } from '../../src/copy/zh-CN/pageMeta'
import { PageTitle } from '../../src/App'

function NavHarness() {
  const navigate = useNavigate()
  return (
    <div>
      <PageTitle />
      <button type="button" data-testid="to-network" onClick={() => navigate('/network')}>n</button>
      <button type="button" data-testid="to-privacy" onClick={() => navigate('/privacy')}>p</button>
      <button type="button" data-testid="to-tos" onClick={() => navigate('/tos')}>t</button>
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/network" element={<div>network</div>} />
        <Route path="/privacy" element={<div>privacy</div>} />
        <Route path="/tos" element={<div>tos</div>} />
      </Routes>
    </div>
  )
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.title = 'initial'
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('07 P2: document.title follows router navigation', () => {
  it('sets the home title on mount and updates on navigate via App.PageTitle', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <NavHarness />
        </MemoryRouter>,
      )
    })
    expect(document.title).toBe(titleForPath('/'))

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="to-network"]')!.click()
    })
    expect(document.title).toBe(titleForPath('/network'))
    expect(document.title).toContain('网络')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="to-privacy"]')!.click()
    })
    expect(document.title).toBe(titleForPath('/privacy'))
    expect(document.title).toContain('隐私')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="to-tos"]')!.click()
    })
    expect(document.title).toBe(titleForPath('/tos'))
    expect(document.title).toContain('服务条款')
  })
})
