import { useState } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaStatusBadge from '@/components/ui/MisakaStatusBadge'
import MisakaProgressBar from '@/components/ui/MisakaProgressBar'
import type { Peer, Transfer } from '@/types'

// ── Placeholder data ──────────────────────────────────────────────
const MOCK_PEERS: Peer[] = [
  { nodeId: 8821,  status: 'online',       channelType: 'direct', joinedAt: Date.now() - 201000 },
  { nodeId: 15003, status: 'transferring', channelType: 'stun',   joinedAt: Date.now() - 85000 },
  { nodeId: 3344,  status: 'offline',      channelType: 'direct', joinedAt: Date.now() - 7200000 },
]
const MOCK_TRANSFERS: Transfer[] = [
  {
    id: 't1', direction: 'send', peerNodeId: 15003, fileName: '実験報告.pdf',
    fileSize: 13000000, progress: 0.78, speedBps: 2200000, status: 'transferring', startedAt: Date.now() - 5000,
  },
  {
    id: 't2', direction: 'recv', peerNodeId: 8821, fileName: '设定集.zip',
    fileSize: 85000000, progress: 1,   speedBps: 0, status: 'completed', startedAt: Date.now() - 120000,
  },
]

function channelLabel(t: Peer['channelType']) {
  return { direct: '直接信道（局域网）', stun: '标准信道（STUN）', relay: '中继信道（TURN）', ws: '备用信道（WS）' }[t]
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

function formatSpeed(bps: number) {
  return `${(bps / 1e6).toFixed(1)} MB/s`
}

// ── NodeRadar ─────────────────────────────────────────────────────
function NodeRadar({ peers, selected, onSelect }: {
  peers: Peer[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-2">
        <MisakaKanjiBlock char="点" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">节点雷达</span>
        <span className="font-jp text-xs text-[var(--text-on-blue-2)] ml-1">ノードレーダー</span>
      </div>
      <div
        className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]"
        style={{ background: 'var(--accent-cyan)' }}
      />

      {peers.length === 0 ? (
        <MisakaCard padding="md" className="text-center">
          <MisakaKanjiBlock char="空" size="lg" className="mx-auto mb-3" />
          <p className="font-kanji text-sm text-[var(--text-on-white)] mb-1">网络中暂无其他实验体</p>
          <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-4">他にネットワーク参加者なし</p>
          <div className="flex gap-2">
            <MisakaButton variant="pill" size="sm" fullWidth>显示我的 QR</MisakaButton>
            <MisakaButton variant="pill" size="sm" fullWidth>复制链接</MisakaButton>
          </div>
        </MisakaCard>
      ) : (
        peers.map(peer => {
          const isSelected = selected === peer.nodeId
          return (
            <MisakaCard
              key={peer.nodeId}
              padding="sm"
              className={`cursor-pointer hover:-translate-y-0.5 hover:shadow-float transition-all duration-150 relative ${isSelected ? 'ring-2 ring-[var(--bg-deep)]' : ''}`}
              style={isSelected ? { background: 'var(--surface-tint)' } : {}}
              onClick={() => onSelect(peer.nodeId)}
            >
              {isSelected && (
                <div
                  className="absolute left-0 top-3 bottom-3 w-1 rounded-r"
                  style={{ background: 'var(--bg-deep)' }}
                />
              )}
              <div className="flex items-center gap-2 mb-2 pl-2">
                <MisakaStatusBadge status={peer.status} />
                <span className="font-kanji font-bold text-sm text-[var(--text-on-white)] ml-auto">
                  御坂 {peer.nodeId} 号
                </span>
              </div>
              <div className="pl-2 space-y-0.5 text-xs text-[var(--text-on-white-2)] font-kanji mb-3">
                <div>▪ {channelLabel(peer.channelType)}</div>
                <div>⏱ {formatDuration(Date.now() - peer.joinedAt)}</div>
              </div>
              <div className="flex gap-1.5 pl-2">
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1.5">📤 发送</MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1.5">💬 消息</MisakaButton>
              </div>
            </MisakaCard>
          )
        })
      )}
    </div>
  )
}

// ── TransferChannel ───────────────────────────────────────────────
function TransferChannel({ selectedPeer }: { selectedPeer: Peer | null }) {
  const [isDragOver, setDragOver] = useState(false)

  if (!selectedPeer) {
    return (
      <MisakaCard
        padding="none"
        className={`flex flex-col items-center justify-center h-full min-h-[400px] transition-all duration-200 ${isDragOver ? 'ring-2 ring-[var(--accent-cyan)] -translate-y-1' : ''}`}
        style={isDragOver ? { background: 'var(--surface-tint)', borderStyle: 'solid', borderColor: 'var(--accent-cyan)' } : { borderStyle: 'dashed' }}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false) }}
      >
        <MisakaKanjiBlock char="同" size="xl" className="mb-4" />
        <p className="font-kanji font-bold text-lg text-[var(--text-on-white)] mb-1">拖拽文件到此处</p>
        <p className="font-jp text-sm text-[var(--text-on-white-2)] mb-3">ファイルをドロップ</p>
        <p className="font-kanji text-sm text-[var(--text-on-white-2)]">或点击选择文件</p>
        <p className="font-kanji text-xs text-[var(--text-muted)] mt-6">── 请先从左侧选择目标节点 ──</p>
      </MisakaCard>
    )
  }

  return (
    <MisakaCard padding="none" className="flex flex-col h-full min-h-[400px]">
      {/* Info bar */}
      <div
        className="px-5 py-3 border-b"
        style={{ background: 'var(--surface-tint)', borderColor: 'var(--border-card)', borderRadius: '1rem 1rem 0 0' }}
      >
        <div className="font-kanji text-sm font-semibold text-[var(--text-on-white)]">
          目标：御坂 {selectedPeer.nodeId} 号
        </div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mt-0.5">
          {channelLabel(selectedPeer.channelType)} · DTLS + AES-GCM
        </div>
      </div>

      {/* Drop zone */}
      <div
        className={`flex-1 flex flex-col items-center justify-center gap-3 p-6 transition-colors ${isDragOver ? '' : ''}`}
        style={isDragOver ? { background: 'var(--surface-tint)' } : {}}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false) }}
      >
        <MisakaButton variant="pill" size="md" className="w-60">
          📁 拖拽 / 点击选择文件
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-60">
          📂 选择文件夹
        </MisakaButton>
      </div>

      {/* Messages */}
      <div
        className="border-t p-4 flex flex-col gap-2"
        style={{ borderColor: 'var(--border-card)', maxHeight: 180, overflowY: 'auto' }}
      >
        <div className="font-kanji text-xs font-semibold text-[var(--text-on-white-2)] mb-1">会话信道</div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          <span className="font-mono mr-2 text-[var(--accent-cyan)]">▸</span>
          [已连接] 人格连接已建立
        </div>
      </div>

      {/* Input */}
      <div
        className="border-t p-3 flex gap-2"
        style={{ borderColor: 'var(--border-card)', borderRadius: '0 0 1rem 1rem' }}
      >
        <input
          type="text"
          placeholder="输入消息…"
          className="flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
          style={{
            border: '1px solid var(--border-card)',
            background: 'var(--surface)',
            color: 'var(--text-on-white)',
          }}
        />
        <MisakaButton variant="primary" size="sm">发送</MisakaButton>
      </div>
    </MisakaCard>
  )
}

// ── TaskPanel ─────────────────────────────────────────────────────
function TaskPanel({ transfers }: { transfers: Transfer[] }) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-2">
        <MisakaKanjiBlock char="流" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">传输面板</span>
        <span className="font-jp text-xs text-[var(--text-on-blue-2)] ml-1">タスクパネル</span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {transfers.map(t => (
        <MisakaCard key={t.id} padding="sm">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs">{t.direction === 'send' ? '📤' : '📥'}</span>
            <span className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
              {t.direction === 'send' ? '→' : '←'} 御坂 {t.peerNodeId} 号
            </span>
          </div>
          <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-2 truncate">
            {t.fileName} · {formatBytes(t.fileSize)}
          </div>

          {t.status === 'transferring' && (
            <>
              <MisakaProgressBar value={t.progress} className="mb-1.5" />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--accent-cyan)' }}>{Math.round(t.progress * 100)}%</span>
                <span>{formatSpeed(t.speedBps)}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1">⏸ 暂停</MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1">✕ 取消</MisakaButton>
              </div>
            </>
          )}

          {t.status === 'completed' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-success)' }} className="font-mono text-xs">✓ 已完成</span>
              <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3">打开</MisakaButton>
            </div>
          )}

          {t.status === 'failed' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-danger)' }} className="font-mono text-xs">✗ 失败</span>
              <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3">重试</MisakaButton>
            </div>
          )}
        </MisakaCard>
      ))}

      {transfers.length === 0 && (
        <MisakaCard padding="md" className="text-center">
          <p className="font-kanji text-sm text-[var(--text-on-white-2)]">暂无传输任务</p>
        </MisakaCard>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────
export default function Network() {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selectedPeer = MOCK_PEERS.find(p => p.nodeId === selectedId) ?? null

  return (
    <div className="min-h-screen pt-16" style={{ background: 'var(--bg-primary)' }}>
      <div
        className="grid h-[calc(100vh-64px)] gap-6 p-6"
        style={{ gridTemplateColumns: '1fr 2fr 1fr' }}
      >
        {/* NodeRadar */}
        <div className="overflow-y-auto">
          <NodeRadar
            peers={MOCK_PEERS}
            selected={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {/* TransferChannel */}
        <TransferChannel selectedPeer={selectedPeer} />

        {/* TaskPanel */}
        <div className="overflow-y-auto">
          <TaskPanel transfers={MOCK_TRANSFERS} />
        </div>
      </div>
    </div>
  )
}
