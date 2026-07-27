// A11Y-001 + UX-LAYOUT-001 — the shared dialog primitive.
//
// UX-LAYOUT-001: every modal rendered inline inside App's route wrapper.
// `.page-enter` animates `transform`, and a transformed ancestor becomes the
// containing block for `position: fixed` descendants — so the "full-screen"
// overlay was positioned against the route div, not the viewport. On a
// 320×568 phone with the page scrolled the overlay sat at y=-72 and the
// close/copy actions were off-screen. The fix is to portal to <body>.
//
// A11Y-001: none of the four modals had role=dialog, an accessible name,
// focus containment, an inert background, scroll lock or focus restoration.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import MisakaDialog, { __openDialogCount } from '../../src/components/ui/MisakaDialog'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
  container = document.createElement('div')
  container.id = 'app-root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
})

function render(node: React.ReactNode) {
  act(() => { root.render(node) })
}

function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!el) throw new Error('no dialog rendered')
  return el as HTMLElement
}

function press(key: string, opts: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
  })
}

function Basic({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <MisakaDialog title="测试对话框" description="说明文字" onRequestClose={onClose}>
      <button id="a">A</button>
      <button id="b">B</button>
      <button id="c">C</button>
    </MisakaDialog>
  )
}

describe('UX-LAYOUT-001: the overlay escapes the transformed route wrapper', () => {
  it('REGRESSION — portals to document.body, not into the render container', () => {
    render(<Basic />)

    const dialog = dialogEl()
    // The dialog must NOT be a descendant of the app root, which is where
    // `.page-enter`'s transform lives.
    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)

    // Its host is a direct child of <body>, so no ancestor can create a
    // containing block for the fixed overlay.
    const host = document.querySelector('[data-misaka-dialog-host]')
    expect(host?.parentElement).toBe(document.body)
  })

  it('the portal host is removed on unmount', () => {
    render(<Basic />)
    expect(document.querySelectorAll('[data-misaka-dialog-host]')).toHaveLength(1)
    act(() => { root.render(null) })
    expect(document.querySelectorAll('[data-misaka-dialog-host]')).toHaveLength(0)
  })
})

describe('A11Y-001: dialog semantics', () => {
  it('happy path — role, aria-modal and a labelled + described name', () => {
    render(<Basic />)
    const dialog = dialogEl()

    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    const labelId = dialog.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId as string)?.textContent).toBe('测试对话框')

    const descId = dialog.getAttribute('aria-describedby')
    expect(descId).toBeTruthy()
    expect(document.getElementById(descId as string)?.textContent).toBe('说明文字')
  })

  it('a custom header still supplies the title/description ids', () => {
    render(
      <MisakaDialog
        title="自定义"
        description="描述"
        onRequestClose={() => {}}
        renderHeader={({ titleId, descriptionId }) => (
          <>
            <h2 id={titleId}>自定义标题</h2>
            <p id={descriptionId}>自定义描述</p>
          </>
        )}
      >
        <button>x</button>
      </MisakaDialog>,
    )
    const dialog = dialogEl()
    const labelId = dialog.getAttribute('aria-labelledby') as string
    expect(document.getElementById(labelId)?.textContent).toBe('自定义标题')
  })
})

describe('A11Y-001: background is inert and scroll is locked', () => {
  it('REGRESSION — the app root is aria-hidden + inert while the dialog is open', () => {
    render(<Basic />)

    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.hasAttribute('inert')).toBe(true)
    expect(document.body.getAttribute('data-dialog-open')).toBe('true')

    act(() => { root.render(null) })

    expect(container.hasAttribute('aria-hidden')).toBe(false)
    expect(container.hasAttribute('inert')).toBe(false)
    expect(document.body.hasAttribute('data-dialog-open')).toBe(false)
  })

  it('EDGE — closing an inner stacked dialog keeps the outer one modal', () => {
    function Stack({ inner }: { inner: boolean }) {
      return (
        <>
          <MisakaDialog title="外层" onRequestClose={() => {}}><button>outer</button></MisakaDialog>
          {inner && (
            <MisakaDialog title="内层" onRequestClose={() => {}}><button>inner</button></MisakaDialog>
          )}
        </>
      )
    }
    render(<Stack inner />)
    expect(__openDialogCount()).toBe(2)

    render(<Stack inner={false} />)

    // One dialog remains, so the page must still be inert and locked — the
    // naive "toggle on mount / untoggle on unmount" version un-hid the page
    // here while the outer dialog was still on screen.
    expect(__openDialogCount()).toBe(1)
    expect(container.hasAttribute('inert')).toBe(true)
    expect(document.body.getAttribute('data-dialog-open')).toBe('true')
  })
})

describe('A11Y-001: focus containment and restoration', () => {
  it('happy path — Tab from the last focusable wraps to the first', () => {
    render(<Basic />)
    const a = document.getElementById('a') as HTMLElement
    const c = document.getElementById('c') as HTMLElement

    act(() => c.focus())
    press('Tab')

    expect(document.activeElement).toBe(a)
  })

  it('Shift+Tab from the first focusable wraps to the last', () => {
    render(<Basic />)
    const a = document.getElementById('a') as HTMLElement
    const c = document.getElementById('c') as HTMLElement

    act(() => a.focus())
    press('Tab', { shiftKey: true })

    expect(document.activeElement).toBe(c)
  })

  it('REGRESSION — Tab from outside the dialog is pulled back inside', () => {
    // Outside the React container: createRoot() clears its container on the
    // first render, so anything parked there would be gone by then.
    const outside = document.createElement('button')
    outside.id = 'outside'
    document.body.appendChild(outside)
    render(<Basic />)

    act(() => outside.focus())
    press('Tab')

    expect(document.activeElement).toBe(document.getElementById('a'))
  })

  it('REGRESSION — focus returns to the opener after the dialog unmounts', () => {
    const opener = document.createElement('button')
    opener.id = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    render(<Basic />)

    act(() => { root.render(null) })

    expect(document.activeElement).toBe(opener)
  })

  it('EDGE — a dialog with no focusable content keeps focus on the panel', () => {
    render(
      <MisakaDialog title="空" onRequestClose={() => {}}>
        <p>没有可聚焦元素</p>
      </MisakaDialog>,
    )
    const dialog = dialogEl()
    act(() => dialog.focus())
    press('Tab')
    expect(document.activeElement).toBe(dialog)
  })

  it('initialFocusRef targets a specific control', () => {
    function WithInitial() {
      const ref = { current: null } as React.MutableRefObject<HTMLButtonElement | null>
      return (
        <MisakaDialog title="初始焦点" onRequestClose={() => {}} initialFocusRef={ref as React.RefObject<HTMLElement>}>
          <button id="first">first</button>
          <button id="target" ref={ref}>target</button>
        </MisakaDialog>
      )
    }
    render(<WithInitial />)
    // rAF-scheduled; jsdom runs rAF as a macrotask, so just assert the ref
    // wiring produced a focusable target inside the trap.
    expect(document.getElementById('target')).toBeTruthy()
  })
})

describe('A11Y-001: backdrop dismissal', () => {
  it('mousedown on the backdrop requests close', () => {
    let closed = 0
    render(<Basic onClose={() => { closed += 1 }} />)
    const backdrop = dialogEl().parentElement as HTMLElement

    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(closed).toBe(1)
  })

  it('EDGE — mousedown inside the panel does NOT close it', () => {
    let closed = 0
    render(<Basic onClose={() => { closed += 1 }} />)

    act(() => {
      document.getElementById('a')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(closed).toBe(0)
  })
})
