import { nodes, channels, qrTokens } from './store.js'

const SESSION_TTL = 30 * 60 * 1000  // 30 minutes

export function startCleanupTask() {
  setInterval(() => {
    const now = Date.now()

    for (const [nodeId, session] of nodes) {
      if (session.socket === null && now - session.lastSeen > SESSION_TTL) {
        nodes.delete(nodeId)
        if (session.channelId) {
          const ch = channels.get(session.channelId)
          if (ch) {
            ch.delete(nodeId)
            if (ch.size === 0) channels.delete(session.channelId)
          }
        }
      }
    }

    for (const [token, record] of qrTokens) {
      if (now > record.expiresAt || record.used) {
        qrTokens.delete(token)
      }
    }

    for (const [channelId, members] of channels) {
      if (members.size === 0) channels.delete(channelId)
    }
  }, 60_000)
}
