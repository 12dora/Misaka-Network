import { useEffect, useRef } from 'react'
import { useHomeStore } from '@/store/home'
import { useAuthStore } from '@/store/auth'
import type { ActivityEvent } from '@/types'

const TYPE_COLOR: Record<ActivityEvent['type'], string> = {
  join:     'var(--state-success)',
  leave:    'var(--text-muted)',
  transfer: 'var(--accent-cyan)',
  channel:  'var(--state-warn)',
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export default function ActivityStream() {
  const activities = useHomeStore(s => s.activities)
  const addActivity = useHomeStore(s => s.addActivity)
  const session = useAuthStore(s => s.session)
  const scrollRef = useRef<HTMLDivElement>(null)

  // WebSocket activity subscription
  useEffect(() => {
    if (!session) return
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws?token=${session.token}`
    const ws = new WebSocket(wsUrl)

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string)
        if (msg.t === 'ACTIVITY') {
          addActivity(msg.event as ActivityEvent)
        }
      } catch {}
    }

    return () => { ws.close() }
  }, [session, addActivity])

  // Auto scroll to left on new activity
  useEffect(() => {
    scrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
  }, [activities])

  if (activities.length === 0) return null

  return (
    <section className="py-4">
      {/* Scrollable stream */}
      <div className="relative">
        {/* Left fade */}
        <div
          className="absolute left-0 top-0 bottom-0 w-16 z-10 pointer-events-none"
          style={{ background: 'linear-gradient(90deg, var(--bg-primary), transparent)' }}
        />
        {/* Right fade */}
        <div
          className="absolute right-0 top-0 bottom-0 w-16 z-10 pointer-events-none"
          style={{ background: 'linear-gradient(270deg, var(--bg-primary), transparent)' }}
        />

        <div
          ref={scrollRef}
          className="flex items-center gap-3 overflow-x-auto px-16 py-4 scroll-smooth"
          style={{ scrollbarWidth: 'none', height: 72 }}
        >
          {activities.map(event => (
            <div
              key={event.id}
              className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-full"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border-card)',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <span
                className={event.type === 'transfer' ? 'pulse-dot' : ''}
                style={{
                  display: 'inline-block',
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: TYPE_COLOR[event.type],
                  flexShrink: 0,
                }}
              />
              <span className="font-mono text-xs text-[var(--text-on-white-2)]">
                {formatTime(event.timestamp)}
              </span>
              <span className="font-kanji text-xs text-[var(--text-on-white)] whitespace-nowrap">
                {event.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
