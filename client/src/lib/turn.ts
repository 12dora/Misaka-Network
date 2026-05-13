const STORAGE_KEY = 'misaka.turnServers'
const BLACKLIST_KEY = 'misaka.blocklist'

export interface TurnServer {
  id: string
  url: string
  username: string
  credential: string
  enabled: boolean
  lastTested?: number
  reachable?: boolean
}

export interface TurnSettings {
  servers: TurnServer[]
  enabled: boolean
  forceRelay: boolean
}

export interface BlockedNode {
  nodeId: number
  reason: string
  blockedAt: number
}

export interface Blocklist {
  blocked: BlockedNode[]
}

// ── TURN settings ────────────────────────────────────────────────────

export function loadTurnSettings(): TurnSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as TurnSettings
  } catch { /* ignore */ }
  return { servers: [], enabled: false, forceRelay: false }
}

export function saveTurnSettings(settings: TurnSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function getTurnIceServers(): RTCIceServer[] {
  const t = loadTurnSettings()
  if (!t.enabled) return []
  return t.servers
    .filter(s => s.enabled)
    .map(s => ({
      urls: s.url,
      username: s.username || undefined,
      credential: s.credential || undefined,
    }))
}

export async function testTurnServer(server: TurnServer): Promise<boolean> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: server.url, username: server.username, credential: server.credential }],
    iceTransportPolicy: 'relay',
  })
  pc.createDataChannel('test')
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  return new Promise(resolve => {
    const timeout = setTimeout(() => { pc.close(); resolve(false) }, 5000)
    pc.onicecandidate = e => {
      if (e.candidate?.candidate.includes(' typ relay ')) {
        clearTimeout(timeout)
        pc.close()
        resolve(true)
      }
    }
  })
}

// ── Blacklist ─────────────────────────────────────────────────────────

export function loadBlocklist(): Blocklist {
  try {
    const raw = localStorage.getItem(BLACKLIST_KEY)
    if (raw) return JSON.parse(raw) as Blocklist
  } catch { /* ignore */ }
  return { blocked: [] }
}

export function saveBlocklist(list: Blocklist) {
  localStorage.setItem(BLACKLIST_KEY, JSON.stringify(list))
}

export function addBlockedNode(nodeId: number, reason: string) {
  const list = loadBlocklist()
  // Don't duplicate
  if (list.blocked.some(b => b.nodeId === nodeId)) return
  list.blocked.push({ nodeId, reason, blockedAt: Date.now() })
  saveBlocklist(list)
}

export function removeBlockedNode(nodeId: number) {
  const list = loadBlocklist()
  list.blocked = list.blocked.filter(b => b.nodeId !== nodeId)
  saveBlocklist(list)
}

export function isNodeBlocked(nodeId: number): boolean {
  const list = loadBlocklist()
  return list.blocked.some(b => b.nodeId === nodeId)
}
