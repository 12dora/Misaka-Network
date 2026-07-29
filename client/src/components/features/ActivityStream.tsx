import { useEffect, useRef, useState } from 'react'
import { ACTIVITY_HISTORY_CAP, useHomeStore } from '@/store/home'
import { useAuthStore } from '@/store/auth'
import { onMessage } from '@/lib/signaling'
import type { ActivityEvent } from '@/types'
import { ACTIVITY_QUOTES } from '@/data/lore'
import { scrollBehavior, useCoarsePointer, useReducedMotion } from '@/hooks/useReducedMotion'
import MisakaButton from '@/components/ui/MisakaButton'

const TYPE_COLOR: Record<ActivityEvent['type'], string> = {
  join:     'var(--state-success)',
  leave:    'var(--text-muted)',
  transfer: 'var(--accent-cyan)',
  channel:  'var(--state-warn)',
}

/** Soft cap for the paused buffer. Beyond this we keep counting drops. */
const PAUSED_BUFFER_SOFT_CAP = 200

type PauseBuffer = {
  events: ActivityEvent[]
  /** Events discarded while over the soft cap (oldest first). */
  dropped: number
}

const EMPTY_PAUSE_BUFFER: PauseBuffer = { events: [], dropped: 0 }

function quoteEvent(index: number): ActivityEvent {
  return {
    id: `quote-${index}-${Math.floor(Date.now() / 60000)}`,
    type: 'channel',
    timestamp: Date.now(),
    message: ACTIVITY_QUOTES[index % ACTIVITY_QUOTES.length],
  }
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Pure: append one event under the soft cap; drop oldest when full. */
function appendPaused(prev: PauseBuffer, event: ActivityEvent): PauseBuffer {
  if (prev.events.length >= PAUSED_BUFFER_SOFT_CAP) {
    return {
      // Newest first; drop oldest (end of array).
      events: [event, ...prev.events.slice(0, PAUSED_BUFFER_SOFT_CAP - 1)],
      dropped: prev.dropped + 1,
    }
  }
  return { events: [event, ...prev.events], dropped: prev.dropped }
}

/**
 * What the flush button promises. The home store only keeps
 * ACTIVITY_HISTORY_CAP rows, so we never claim more than that will remain.
 */
export function flushDisclosure(buffer: PauseBuffer): {
  retained: number
  omitted: number
  label: string
} {
  const retained = Math.min(buffer.events.length, ACTIVITY_HISTORY_CAP)
  const omittedFromHistory =
    Math.max(0, buffer.events.length - ACTIVITY_HISTORY_CAP) + buffer.dropped
  if (omittedFromHistory > 0) {
    return {
      retained,
      omitted: omittedFromHistory,
      label: `有 ${retained} 条新动态（另有 ${omittedFromHistory} 条较早动态已省略）`,
    }
  }
  return {
    retained: buffer.events.length,
    omitted: 0,
    label: `有 ${buffer.events.length} 条新动态`,
  }
}

type StreamItem = ActivityEvent & { exiting?: boolean }

export default function ActivityStream() {
  const activities = useHomeStore(s => s.activities)
  const addActivity = useHomeStore(s => s.addActivity)
  const session = useAuthStore(s => s.session)
  const scrollRef = useRef<HTMLDivElement>(null)
  const quoteIndex = useRef(0)
  const reducedMotion = useReducedMotion()
  const coarsePointer = useCoarsePointer()
  const [paused, setPaused] = useState(false)
  // Single pure state transition — never call setState from inside an updater
  // (StrictMode double-invokes updaters and would double-count drops).
  const [pauseBuffer, setPauseBuffer] = useState<PauseBuffer>(EMPTY_PAUSE_BUFFER)
  // Keep pause out of the subscription deps — the effect must only re-bind
  // when session / addActivity change.
  const pausedRef = useRef(false)
  const [displayItems, setDisplayItems] = useState<StreamItem[]>(() => activities.map(a => ({ ...a })))
  const prevIdsRef = useRef<string[]>(activities.map(a => a.id))
  const motionStopped = paused || reducedMotion || coarsePointer

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // 08 P1: subscription depends only on session + addActivity.
  useEffect(() => {
    if (!session) return
    return onMessage((msg) => {
      if (msg.t !== 'ACTIVITY') return
      const event = msg.event as ActivityEvent
      if (pausedRef.current) {
        setPauseBuffer(prev => appendPaused(prev, event))
      } else {
        addActivity(event)
      }
    })
  }, [session, addActivity])

  useEffect(() => {
    if (!session) return
    const timer = window.setInterval(() => {
      quoteIndex.current += 1
      const q = quoteEvent(quoteIndex.current)
      if (pausedRef.current) {
        setPauseBuffer(prev => appendPaused(prev, q))
      } else {
        addActivity(q)
      }
    }, 45_000)
    return () => window.clearInterval(timer)
  }, [session, addActivity])

  // Enter/exit presentation: newest items animate in; removed rows exit before
  // being dropped from the DOM so the list does not pop.
  useEffect(() => {
    const nextIds = activities.map(a => a.id)
    const prevIds = prevIdsRef.current
    const same =
      nextIds.length === prevIds.length &&
      nextIds.every((id, i) => id === prevIds[i])
    if (same) return

    const removed = prevIds.filter(id => !nextIds.includes(id))
    prevIdsRef.current = nextIds

    if (reducedMotion || removed.length === 0) {
      setDisplayItems(activities.map(a => ({ ...a })))
      return
    }

    setDisplayItems(prev => {
      const live = activities.map(a => ({ ...a }))
      const exiting = prev
        .filter(p => removed.includes(p.id) && !p.exiting)
        .map(p => ({ ...p, exiting: true }))
      return [...live, ...exiting]
    })

    const t = window.setTimeout(() => {
      setDisplayItems(activities.map(a => ({ ...a })))
    }, 180)
    return () => window.clearTimeout(t)
  }, [activities, reducedMotion])

  useEffect(() => {
    if (!motionStopped && scrollRef.current && typeof scrollRef.current.scrollTo === 'function') {
      scrollRef.current.scrollTo({ left: 0, behavior: scrollBehavior() })
    }
  }, [activities, motionStopped])

  function flushBuffer() {
    if (pauseBuffer.events.length === 0) return
    // Newest-first buffer; only the newest ACTIVITY_HISTORY_CAP will remain
    // after the store truncates. Flush that slice oldest-first so addActivity
    // prepends produce the same order as a live stream.
    const newest = pauseBuffer.events.slice(0, ACTIVITY_HISTORY_CAP)
    for (let i = newest.length - 1; i >= 0; i--) {
      addActivity(newest[i])
    }
    setPauseBuffer(EMPTY_PAUSE_BUFFER)
  }

  function handleTogglePause() {
    setPaused(value => {
      if (value && pauseBuffer.events.length > 0) {
        // Resuming merges the buffered events so nothing is lost silently.
        Promise.resolve().then(flushBuffer)
      }
      return !value
    })
  }

  const disclosure = flushDisclosure(pauseBuffer)
  const pendingCount = pauseBuffer.events.length + pauseBuffer.dropped
  if (activities.length === 0 && pauseBuffer.events.length === 0 && displayItems.length === 0) return null

  return (
    <section className="py-4">
      {!reducedMotion && !coarsePointer && (
        <div className="flex justify-end items-center gap-2 px-5">
          {paused && pendingCount > 0 && (
            <MisakaButton
              variant="pill"
              size="sm"
              className="text-[11px] py-1 px-2"
              onClick={flushBuffer}
              data-testid="activity-flush-buffer"
              data-retained={disclosure.retained}
              data-omitted={disclosure.omitted}
            >
              {disclosure.label}
            </MisakaButton>
          )}
          <MisakaButton
            variant="pill"
            size="sm"
            className="text-[11px] py-1 px-2"
            aria-pressed={paused}
            onClick={handleTogglePause}
          >
            {paused ? '▶ 继续动态' : '⏸ 暂停动态'}
          </MisakaButton>
        </div>
      )}
      <div className="relative">
        <div
          className="absolute left-0 top-0 bottom-0 w-16 z-10 pointer-events-none"
          style={{ background: 'linear-gradient(90deg, var(--bg-primary), transparent)' }}
        />
        <div
          className="absolute right-0 top-0 bottom-0 w-16 z-10 pointer-events-none"
          style={{ background: 'linear-gradient(270deg, var(--bg-primary), transparent)' }}
        />

        <div
          ref={scrollRef}
          className="flex items-center gap-3 overflow-x-auto px-16 py-4"
          style={{ scrollbarWidth: 'none', height: 72 }}
        >
          {displayItems.map((event, idx) => (
            <div
              key={event.id}
              data-testid={event.exiting ? 'activity-item-exit' : 'activity-item'}
              className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-full ${
                !reducedMotion && event.exiting
                  ? 'activity-exit'
                  : !reducedMotion && idx === 0 && !event.exiting
                    ? 'activity-enter'
                    : ''
              }`}
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
