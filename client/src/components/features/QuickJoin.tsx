import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'

const CARDS = [
  {
    icon: '📷',
    kanji: '読',
    label: '扫码接入',
    furigana: 'カメラから接続',
    desc: '扫描对方节点的 QR 码快速接入',
    action: '开始扫描',
  },
  {
    icon: '⌨',
    kanji: '入',
    label: '输入通行码',
    furigana: 'パスコード入力',
    desc: '手动输入节点编号与通行码建立连接',
    action: '打开输入',
  },
  {
    icon: '📖',
    kanji: '識',
    label: '了解御坂网络',
    furigana: 'みさかについて',
    desc: '世界观介绍、角色档案与彩蛋功能',
    action: '前往 ACGN',
    to: '/acgn',
  },
]

export default function QuickJoin() {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="px-5 md:px-8 py-14">
      <div className="section-header">
        <div className="title-row">
          <MisakaKanjiBlock char="入" size="lg" />
          <h2>快速接入</h2>
        </div>
        <p className="furigana">クイックアクセス</p>
        <div className="accent-line" />
      </div>

      <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-3xl">
        {CARDS.map((card, idx) => (
          <MisakaCard
            key={card.kanji}
            padding="md"
            className="flex flex-col items-center text-center hover:-translate-y-1 hover:shadow-float transition-all duration-200"
            style={{
              opacity: visible ? undefined : 0,
              animation: visible ? `card-in 0.45s ease ${idx * 0.1}s forwards` : 'none',
            }}
          >
            <span className="text-4xl mb-3">{card.icon}</span>
            <div className="flex items-center gap-1.5 mb-1">
              <MisakaKanjiBlock char={card.kanji} size="sm" />
              <span className="font-kanji font-bold text-base text-[var(--text-on-white)]">{card.label}</span>
            </div>
            <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-2">{card.furigana}</p>
            <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4 leading-relaxed">{card.desc}</p>
            <MisakaButton
              variant="primary"
              size="sm"
              fullWidth
              onClick={() => card.to && navigate(card.to)}
            >
              {card.action}
            </MisakaButton>
          </MisakaCard>
        ))}
      </div>
    </section>
  )
}
