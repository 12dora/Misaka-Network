import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ── Shared dialog primitive (A11Y-001 + UX-LAYOUT-001) ──────────────────
//
// UX-LAYOUT-001: every modal used to render inline, inside App's route
// wrapper. `.page-enter` animates `transform`, and a transformed ancestor
// becomes the containing block for `position: fixed` descendants — so the
// "full-screen" overlay was positioned relative to the route div instead of
// the viewport. On a 320×568 phone with the page scrolled, the overlay sat
// at y=-72 and the close/copy actions were off-screen. Portalling to
// `document.body` takes the overlay out of that containing block entirely.
//
// A11Y-001: the four modals each hand-rolled their own markup, so none of
// them had `role=dialog`, an accessible name, focus containment, an inert
// background, scroll lock or focus restoration. All of that lives here now
// and every modal gets it by construction.

interface Props {
  /** Fires when the backdrop, Escape, or a close control asks to dismiss. */
  onRequestClose: () => void
  /** Visible title text — used as the accessible name via aria-labelledby. */
  title: string
  /** Optional supporting text, wired up as aria-describedby. */
  description?: string
  /** Render-prop for the header so each modal keeps its own visual design. */
  renderHeader?: (ids: { titleId: string; descriptionId: string }) => ReactNode
  children: ReactNode

  /** Animation classes from `useModalExit`. */
  backdropClass?: string
  panelClass?: string

  backdropStyle?: CSSProperties
  panelStyle?: CSSProperties
  panelClassName?: string
  /** Extra classes for the backdrop (layout of the panel inside it). */
  backdropClassName?: string

  /**
   * Element to focus on open. Defaults to the panel itself, which is
   * `tabIndex={-1}` so screen readers announce the dialog name first.
   */
  initialFocusRef?: React.RefObject<HTMLElement>
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Deliberately layout-free. `offsetParent`/`getBoundingClientRect` are the
 * usual visibility heuristic, but `position: fixed` panels report a null
 * offsetParent in real browsers and jsdom reports zeros for everything, so
 * either would empty the trap. `checkVisibility()` does the right thing
 * where it exists and we fall back to attribute checks where it doesn't.
 */
function isReachable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return false
  if (el.hasAttribute('hidden')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  if (el.closest('[inert]')) return false
  const checkVisibility = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof checkVisibility === 'function') return checkVisibility.call(el)
  return true
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isReachable)
}

// Stack of mounted dialog hosts, outermost first. Dialogs can nest
// (LoginCard shows IpFullPrompt over ScanModal), so background inertness,
// scroll lock and banner suppression are recomputed from the stack rather
// than toggled per-dialog — otherwise closing the inner dialog would
// un-hide the page while the outer one is still open.
const dialogStack: HTMLElement[] = []
const backgroundState = new Map<HTMLElement, { inert: string | null; ariaHidden: string | null }>()

function setInert(el: HTMLElement, on: boolean) {
  if (on) {
    if (!backgroundState.has(el)) {
      backgroundState.set(el, {
        inert: el.getAttribute('inert'),
        ariaHidden: el.getAttribute('aria-hidden'),
      })
    }
    el.setAttribute('aria-hidden', 'true')
    // `inert` also removes the subtree from the tab order and from hit
    // testing in browsers that ship it; aria-hidden alone leaves the
    // background keyboard-reachable.
    el.setAttribute('inert', '')
  } else {
    const original = backgroundState.get(el)
    if (!original) return
    if (original.ariaHidden === null) el.removeAttribute('aria-hidden')
    else el.setAttribute('aria-hidden', original.ariaHidden)
    if (original.inert === null) el.removeAttribute('inert')
    else el.setAttribute('inert', original.inert)
    backgroundState.delete(el)
  }
}

function syncBackground() {
  const top = dialogStack[dialogStack.length - 1]
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue
    setInert(child, Boolean(top) && child !== top)
  }
  if (dialogStack.length > 0) document.body.setAttribute('data-dialog-open', 'true')
  else document.body.removeAttribute('data-dialog-open')
}

export default function MisakaDialog({
  onRequestClose,
  title,
  description,
  renderHeader,
  children,
  backdropClass = '',
  panelClass = '',
  backdropStyle,
  panelStyle,
  panelClassName = '',
  // Safe-area padding: QR/Scan panels may be up to 90svh tall. Flat 16px
  // padding puts the close button and its 44px hit target under the notch on
  // a 393×852 iPhone. Default uses max(1rem, safe-*) so every consumer gets
  // the inset without re-computing it.
  backdropClassName = 'flex items-center justify-center misaka-dialog-backdrop',
  initialFocusRef,
}: Props) {
  const reactId = useId()
  const titleId = `misaka-dialog-title-${reactId}`
  const descriptionId = `misaka-dialog-desc-${reactId}`

  const panelRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Create the portal host synchronously so the first paint already happens
  // outside the transformed route wrapper — otherwise the panel would flash
  // at the wrong offset for one frame.
  if (hostRef.current === null && typeof document !== 'undefined') {
    const host = document.createElement('div')
    host.setAttribute('data-misaka-dialog-host', '')
    hostRef.current = host
  }

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    document.body.appendChild(host)

    dialogStack.push(host)
    // Scroll lock + banner suppression are CSS-driven off `data-dialog-open`
    // so there is exactly one owner of the body style.
    syncBackground()

    return () => {
      const idx = dialogStack.indexOf(host)
      if (idx >= 0) dialogStack.splice(idx, 1)
      syncBackground()
      // A host being removed may still have been inert while another dialog
      // was above it. Restore and forget its snapshot before detaching.
      setInert(host, false)
      host.remove()
      // Focus restoration — without this the user is dumped at the top of
      // the (previously inert) page with no idea where they were.
      const restore = restoreFocusRef.current
      if (restore && document.contains(restore)) {
        try { restore.focus({ preventScroll: true }) } catch { /* detached */ }
      }
    }
  }, [])

  // Initial focus.
  useEffect(() => {
    const target = initialFocusRef?.current ?? panelRef.current
    if (!target) return
    // rAF so the entrance animation has committed and the element is laid
    // out; focusing a zero-size element is a no-op in some browsers.
    const id = requestAnimationFrame(() => {
      try { target.focus({ preventScroll: true }) } catch { /* ignore */ }
    })
    return () => cancelAnimationFrame(id)
  }, [initialFocusRef])

  // Focus containment + top-of-stack Escape. Handling Escape here gives
  // direct consumers (IpFullPrompt) the same behavior as animated modals and
  // prevents one keypress reaching every window listener in a dialog stack.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (dialogStack[dialogStack.length - 1] !== hostRef.current) return
        e.preventDefault()
        e.stopImmediatePropagation()
        onRequestClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = focusableWithin(panel)
      if (items.length === 0) {
        // Nothing focusable inside — keep focus on the panel rather than
        // letting Tab escape into the inert background.
        e.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = active ? panel.contains(active) : false

      if (!inside) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onRequestClose])

  const host = hostRef.current
  if (!host) return null

  const header = renderHeader
    ? renderHeader({ titleId, descriptionId })
    : (
      <>
        <h2 id={titleId} className="sr-only">{title}</h2>
        {description && <p id={descriptionId} className="sr-only">{description}</p>}
      </>
    )

  return createPortal(
    <div
      className={`fixed inset-0 ${backdropClassName} ${backdropClass}`}
      // Backdrop dismissal on mousedown (not click): a drag that starts
      // inside the panel and ends on the backdrop should not close it.
      // 100 == `--z-dialog`; kept numeric so a caller can raise a stacked
      // dialog (IpFullPrompt uses 110) with a plain style override.
      style={{ zIndex: 100, ...backdropStyle }}
      onMouseDown={e => { if (e.target === e.currentTarget) onRequestClose() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`misaka-dialog-panel ${panelClassName} ${panelClass}`}
        style={{ outline: 'none', ...panelStyle }}
        onMouseDown={e => e.stopPropagation()}
      >
        {header}
        {children}
      </div>
    </div>,
    host,
  )
}

/** Test/diagnostic helper — how many dialogs are currently mounted. */
export function __openDialogCount() {
  return dialogStack.length
}
