import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import { useAuthStore } from '@/store/auth'
import { apiUrl } from '@/config'

export default function Join() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<'connecting' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const auth = useAuthStore()

  useEffect(() => {
    async function handleJoin() {
      const type = params.get('type')
      const qrToken = params.get('t')
      const fileSessionId = params.get('fid')
      const encodedPass = params.get('c')

      if (!qrToken) {
        setStatus('error')
        setErrorMsg('无效的 QR 链接')
        return
      }

      // Ensure identity exists
      let identity = auth.identity
      if (!identity) {
        // Trigger identity generation — auth store generates on first access
        identity = auth.identity
      }

      // If not connected, connect first
      if (!auth.isConnected && !auth.isLoading) {
        try {
          await auth.connect()
        } catch {
          setStatus('error')
          setErrorMsg('网络接入失败，请返回首页手动连接后再试')
          return
        }
      }

      // If still not connected after connect attempt
      if (!auth.session) {
        setStatus('error')
        setErrorMsg('请先返回首页完成身份注册')
        return
      }

      // Build QR redeem payload
      const payload: Record<string, unknown> = {
        qrToken,
        myNodeId: auth.identity.nodeId,
        myPassCode: auth.identity.passCode,
      }

      // Call qr-redeem
      try {
        const res = await fetch(apiUrl('/api/qr-redeem'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'UNKNOWN' }))
          setStatus('error')
          setErrorMsg(err.error === 'INVALID_QR_TOKEN' ? 'QR 码已过期或已被使用' : '接入失败')
          return
        }

        const data = await res.json() as { targetNodeId: number; channelId: string }

        // Store join context for the network page
        sessionStorage.setItem('misaka.join', JSON.stringify({
          targetNodeId: data.targetNodeId,
          channelId: data.channelId,
          type,
          fileSessionId,
          encodedPass,
        }))

        // Navigate to network
        navigate('/network', { replace: true })
      } catch {
        setStatus('error')
        setErrorMsg('网络请求失败')
      }
    }

    handleJoin()
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
      <div
        className="flex flex-col items-center gap-6 rounded-2xl p-8"
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          minWidth: 300,
        }}
      >
        {status === 'connecting' ? (
          <>
            <MisakaKanjiBlock char="接" size="lg" />
            <div className="text-center">
              <div className="font-kanji font-bold text-lg text-[var(--text-on-white)]">
                正在接入御坂网络
              </div>
              <div className="font-jp text-xs text-[var(--text-on-white-2)] mt-1">
                接続中…
              </div>
            </div>
            <div
              className="w-12 h-1 rounded-full animate-pulse"
              style={{ background: 'var(--accent-cyan)' }}
            />
          </>
        ) : (
          <>
            <MisakaKanjiBlock char="断" size="lg" />
            <div className="text-center">
              <div className="font-kanji font-bold text-lg text-[var(--state-danger)]">
                接入失败
              </div>
              <div className="font-jp text-xs text-[var(--text-on-white-2)] mt-1">
                {errorMsg}
              </div>
            </div>
            <button
              className="nav-pill"
              onClick={() => navigate('/', { replace: true })}
            >
              返回首页
            </button>
          </>
        )}
      </div>
    </div>
  )
}
