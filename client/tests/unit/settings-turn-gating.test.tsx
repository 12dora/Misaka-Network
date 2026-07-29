// BUG-008 (UI half) — the TURN master switch must gate BOTH auto and manual
// TURN, and "force relay" must be impossible to leave armed when there is no
// TURN available.
//
// The audit found two reachable states:
//   1. cache auto-TURN credentials, then flip the master switch off — the
//      lib still appended the cached servers (that invariant is the lib
//      fix); the UI additionally claimed the switch only governed the manual
//      list, so the user had no reason to expect relaying to continue;
//   2. arm "强制使用 TURN" with no reachable relay — a `relay`-only ICE
//      policy with an empty relay set guarantees every connection fails.
//
// This test drives the real SettingsModal so the gate is verified against
// the shipped component, not a re-implementation.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const autoTurnState = { active: false, expiresAt: null as number | null, lastFailReason: null as string | null }

vi.mock('@/lib/turn', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/turn')>(),
  loadTurnSettings: () => loaded,
  saveTurnSettings: (s: unknown) => { saved.push(JSON.parse(JSON.stringify(s))) },
  testTurnServerDetailed: vi.fn(async () => ({ reachable: false, code: 'NO_RELAY', message: 'x' })),
  fetchTurnStatus: vi.fn(async () => null),
  getAutoTurnState: () => ({ ...autoTurnState }),
  refreshAutoTurn: vi.fn(async () => []),
}))
vi.mock('@/lib/nat', () => ({ detectNatType: vi.fn(async () => ({ type: 'unknown', reason: '', publicEndpoints: [] })) }))
vi.mock('@/lib/sound', () => ({
  isSoundEnabled: () => false,
  setSoundEnabled: vi.fn(),
  subscribeSoundPreference: () => () => {},
  playSound: vi.fn(),
}))
vi.mock('@/lib/notify', () => ({ ensureNotificationPermission: vi.fn(async () => 'default') }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

interface Settings {
  servers: { id: string; url: string; username: string; credential: string; enabled: boolean }[]
  enabled: boolean
  forceRelay: boolean
}

let loaded: Settings
let saved: Settings[]

import SettingsModal from '../../src/components/features/SettingsModal'

let container: HTMLDivElement
let root: Root

function render() {
  act(() => { root.render(<SettingsModal onClose={() => {}} />) })
}

/** Find a `role=switch` by its accessible name. */
function switchByName(name: string): HTMLButtonElement {
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
  const found = all.find(el => {
    const id = el.getAttribute('aria-labelledby')
    return id ? document.getElementById(id)?.textContent === name : false
  })
  if (!found) throw new Error(`no switch named ${name}; have: ${all.map(e => e.getAttribute('aria-labelledby')).join(', ')}`)
  return found
}

const MANUAL_SERVER = { id: 's1', url: 'turn:relay.example:3478', username: 'u', credential: 'c', enabled: true }

beforeEach(() => {
  saved = []
  loaded = { servers: [], enabled: false, forceRelay: false }
  autoTurnState.active = false
  autoTurnState.expiresAt = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dialog-open')
})

describe('A11Y-003: the settings toggles are real switches', () => {
  it('exposes role=switch, aria-checked and an accessible name', () => {
    loaded = { servers: [MANUAL_SERVER], enabled: true, forceRelay: false }
    render()

    const master = switchByName('服务器协助连接')
    expect(master.getAttribute('role')).toBe('switch')
    expect(master.getAttribute('aria-checked')).toBe('true')

    const force = switchByName('强制服务器协助（仅测试）')
    expect(force.getAttribute('aria-checked')).toBe('false')
  })
})

describe('BUG-008 (UI): the master switch is the single gate', () => {
  it('happy path — with TURN on and a manual server, force relay is available', () => {
    loaded = { servers: [MANUAL_SERVER], enabled: true, forceRelay: false }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(false)
  })

  it('happy path — with TURN on and auto credentials issued, force relay is available', () => {
    autoTurnState.active = true
    autoTurnState.expiresAt = Date.now() + 60_000
    loaded = { servers: [], enabled: true, forceRelay: false }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(false)
  })

  it('REGRESSION — the master switch off disables force relay even with cached auto TURN', () => {
    // This is exactly the audited scenario: credentials were already issued
    // and cached, then the user turned the master switch off.
    autoTurnState.active = true
    autoTurnState.expiresAt = Date.now() + 60_000
    loaded = { servers: [MANUAL_SERVER], enabled: false, forceRelay: false }
    render()

    const force = switchByName('强制服务器协助（仅测试）')
    expect(force.disabled).toBe(true)
    expect(document.body.textContent).toContain('需要先启用服务器协助连接')
  })

  it('REGRESSION — an armed force-relay is CLEARED when no TURN is available', () => {
    // The dangerous state: relay-only policy with an empty relay set.
    loaded = { servers: [], enabled: true, forceRelay: true }
    render()

    const force = switchByName('强制服务器协助（仅测试）')
    expect(force.getAttribute('aria-checked')).toBe('false')
    expect(force.disabled).toBe(true)
    // …and the cleared value is persisted, so the next PC build can't pick
    // the stale flag back up out of localStorage.
    expect(saved.at(-1)?.forceRelay).toBe(false)
  })

  it('EDGE — a manual server that is present but disabled does not count as available', () => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, enabled: false }],
      enabled: true,
      forceRelay: false,
    }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(true)
    expect(document.body.textContent).toContain('当前没有可用的协助服务器')
  })

  it.each([
    ['missing username', { username: '' }],
    ['missing credential', { credential: '' }],
  ])('EDGE — %s does not enable relay-only mode', (_label, patch) => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, ...patch }],
      enabled: true,
      forceRelay: true,
    }
    render()

    const force = switchByName('强制服务器协助（仅测试）')
    expect(force.disabled).toBe(true)
    expect(force.getAttribute('aria-checked')).toBe('false')
  })

  it('EDGE — a manual server with a blank URL does not count as available', () => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, url: '   ' }],
      enabled: true,
      forceRelay: false,
    }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(true)
  })

  it('REGRESSION — arbitrary text such as "foo" is not a usable relay', () => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, url: 'foo' }],
      enabled: true,
      forceRelay: true,
    }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(true)
    expect(switchByName('强制服务器协助（仅测试）').getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    'turn:relay..example:3478',
    'turn:relay_example:3478',
    'turn:relay.example:3478?transport=udp&',
    'turn:relay.example%40attacker.test:3478',
    'turn:[2001:::1]:3478',
    'turn:[::ffff:999.0.2.1]:3478',
  ])('EDGE — malformed relay URI does not enable relay-only mode: %s', url => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, url }],
      enabled: true,
      forceRelay: true,
    }
    render()

    const force = switchByName('强制服务器协助（仅测试）')
    expect(force.disabled).toBe(true)
    expect(force.getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    'turn:[2001:0db8::1]:3478',
    'turn:[0:0:0:0:0:0:0:1]:3478',
    'turn:[::ffff:192.0.2.1]:3478',
  ])('EDGE — semantically valid bracketed IPv6 enables relay-only mode: %s', url => {
    loaded = {
      servers: [{ ...MANUAL_SERVER, url }],
      enabled: true,
      forceRelay: false,
    }
    render()

    expect(switchByName('强制服务器协助（仅测试）').disabled).toBe(false)
  })

  it('the copy states that the master switch governs auto issuance too', () => {
    loaded = { servers: [], enabled: true, forceRelay: false }
    render()
    expect(document.body.textContent).toContain('自动下发和手工服务器都不会用于连接')
  })
})

describe('BUG-026 (UI): a failed TURN status fetch is surfaced, not swallowed', () => {
  it('shows an explicit failure with a retry instead of rendering nothing', async () => {
    loaded = { servers: [], enabled: true, forceRelay: false }
    render()
    // fetchTurnStatus is mocked to resolve null (its failure contract).
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).toContain('暂时无法获取中继服务状态')
  })
})

describe('TURN three-state: open settings must not persist defaults', () => {
  it('does not call saveTurnSettings on mount with no user change', async () => {
    loaded = { servers: [], enabled: false, forceRelay: false }
    render()
    await act(async () => { await Promise.resolve() })
    // Mount alone must not write — that used to flip unset → disabled.
    expect(saved).toHaveLength(0)
  })

  it('StrictMode double effect setup still does not persist defaults', async () => {
    // The app wraps itself in <StrictMode> (main.tsx). A one-shot ref skips
    // only the first effect setup; the second setup must also avoid writing.
    const { StrictMode } = await import('react')
    loaded = { servers: [], enabled: false, forceRelay: false }
    await act(async () => {
      root.render(
        <StrictMode>
          <SettingsModal onClose={() => {}} />
        </StrictMode>,
      )
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(saved).toHaveLength(0)
  })

  it('gates the issue button when master switch is off', async () => {
    const { fetchTurnStatus, refreshAutoTurn } = await import('../../src/lib/turn')
    vi.mocked(fetchTurnStatus).mockResolvedValue({
      enabled: true,
      configured: true,
      provider: 'cf',
      credentialTtlSec: 600,
      available: true,
      detailed: false,
    })
    loaded = { servers: [], enabled: false, forceRelay: false }
    render()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const buttons = Array.from(document.querySelectorAll('button'))
    const issue = buttons.find(b => b.textContent?.includes('下发中继凭证'))
    expect(issue).toBeTruthy()
    expect(issue!.disabled).toBe(true)

    // Even if clicked somehow, force path is gated in UI.
    await act(async () => { issue!.click() })
    expect(refreshAutoTurn).not.toHaveBeenCalled()
  })
})
