import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import { useAuthStore } from '@/store/auth'
import { apiUrl } from '@/config'

type JoinStatus = 'connecting' | 'needs-passcode' | 'error'

function decodePassCode(encoded: string | null): string {
  if (!encoded) return ''
  try {
    return atob(encoded).replace(/\D/g, '').slice(0, 6)
  } catch {
    return ''
  }
}

function isValidPassCode(passCode: string) {
  return /^\d{6}$/.test(passCode)
}

export default function Join() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const auth = useAuthStore()
  const [status, setStatus] = useState<JoinStatus>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [passCode, setPassCode] = useState(() => decodePassCode(params.get('c')))
  const [manualPass, setManualPass] = useState('')
  const [attempt, setAttempt] = useState(0)

  const joinInfo = useMemo(() => ({
    type: params.get('type') ?? 'node',
    targetNodeId: Number(params.get('id')),
    qrToken: params.get('t') ?? '',
    fileSessionId: params.get('fid'),
    encodedPass: params.get('c'),
  }), [params])

  useEffect(() => {
    if (attempt > 0) return
    if (!joinInfo.qrToken || !Number.isInteger(joinInfo.targetNodeId) || joinInfo.targetNodeId < 1 || joinInfo.targetNodeId > 20001) {
      setStatus('error')
      setErrorMsg('无效的 QR 链接')
      return
    }
    if (!isValidPassCode(passCode)) {
      setStatus('needs-passcode')
      return
    }
    setAttempt(1)
  }, [attempt, joinInfo.qrToken, joinInfo.targetNodeId, passCode])

  useEffect(() => {
    if (attempt === 0) return
    let cancelled = false

    async function handleJoin() {
      setStatus('connecting')
      setErrorMsg('')

      try {
        auth.setNodeId(joinInfo.targetNodeId)
        auth.setPassCode(passCode)

        const res = await fetch(apiUrl('/api/qr-redeem'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            qrToken: joinInfo.qrToken,
            myNodeId: joinInfo.targetNodeId,
            myPassCode: passCode,
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'UNKNOWN' })) as { error?: string }
          if (cancelled) return
          if (err.error === 'QR_REQUIRES_PASSCODE' || err.error === 'WRONG_PASSCODE') {
            setStatus('needs-passcode')
            setErrorMsg(err.error === 'WRONG_PASSCODE' ? '通行码不正确，请重新输入' : '')
          } else {
            setStatus('error')
            setErrorMsg(err.error === 'INVALID_QR_TOKEN' ? 'QR 码已过期或已被使用' : '接入失败')
          }
          return
        }

        const data = await res.json() as { targetNodeId: number; channelId: string }

        sessionStorage.setItem('misaka.join', JSON.stringify({
          targetNodeId: data.targetNodeId,
          channelId: data.channelId,
          type: joinInfo.type,
          fileSessionId: joinInfo.fileSessionId,
          encodedPass: joinInfo.encodedPass,
        }))

        await auth.connect()
        if (cancelled) return

        if (useAuthStore.getState().isConnected) {
          navigate('/network', { replace: true })
        } else {
          setStatus('error')
          setErrorMsg(useAuthStore.getState().error ?? '接入失败，请稍后重试')
        }
      } catch {
        if (!cancelled) {
          setStatus('error')
          setErrorMsg('网络请求失败')
        }
      }
    }

    handleJoin()
    return () => { cancelled = true }
  }, [attempt, joinInfo, navigate, passCode])

  function submitPassCode() {
    const next = manualPass.replace(/\D/g, '').slice(0, 6)
    if (!isValidPassCode(next)) {
      setErrorMsg('请输入 6 位通行码')
      return
    }
    setPassCode(next)
    setManualPass('')
    setAttempt(prev => prev + 1)
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-primary)' }}>
      <div
        className="flex flex-col items-center gap-6 rounded-2xl p-8"
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          width: 'min(360px, 100%)',
        }}
      >
        {status === 'connecting' && (
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
            <div className="w-12 h-1 rounded-full animate-pulse" style={{ background: 'var(--accent-cyan)' }} />
          </>
        )}

        {status === 'needs-passcode' && (
          <>
            <MisakaKanjiBlock char="鍵" size="lg" />
            <div className="text-center">
              <div className="font-kanji font-bold text-lg text-[var(--text-on-white)]">
                输入通行码
              </div>
              <div className="font-jp text-xs text-[var(--text-on-white-2)] mt-1">
                御坂 {joinInfo.targetNodeId} 号への接続
              </div>
            </div>
            <input
              value={manualPass}
              onChange={e => setManualPass(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter') submitPassCode() }}
              inputMode="numeric"
              maxLength={6}
              autoFocus
              placeholder="000000"
              className="misaka-input text-center font-mono text-xl tracking-[0.35em]"
            />
            {errorMsg && (
              <p className="font-kanji text-xs text-[var(--state-danger)] text-center">{errorMsg}</p>
            )}
            <div className="flex gap-2 w-full">
              <MisakaButton variant="pill" size="sm" fullWidth onClick={() => navigate('/', { replace: true })}>
                返回首页
              </MisakaButton>
              <MisakaButton variant="primary" size="sm" fullWidth disabled={!isValidPassCode(manualPass)} onClick={submitPassCode}>
                接入
              </MisakaButton>
            </div>
          </>
        )}

        {status === 'error' && (
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
            <MisakaButton variant="pill" onClick={() => navigate('/', { replace: true })}>
              返回首页
            </MisakaButton>
          </>
        )}
      </div>
    </div>
  )
}
