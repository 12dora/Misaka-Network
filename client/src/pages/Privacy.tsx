import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaCard from '@/components/ui/MisakaCard'
import { legal } from '@/copy/zh-CN/legal'

export default function Privacy() {
  const p = legal.privacy
  return (
    <div className="px-4" style={{ background: 'var(--bg-primary)', minHeight: '100dvh', paddingTop: 'calc(var(--nav-h-total) + 1rem)', paddingBottom: 'calc(5rem + var(--safe-bottom))' }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <MisakaKanjiBlock char="秘" size="md" />
          <h1 className="font-kanji font-bold text-xl text-white">{p.title}</h1>
        </div>

        <MisakaCard padding="md" className="space-y-4 font-kanji text-sm leading-relaxed">
          <p>{p.intro}</p>

          <h2 className="font-bold mt-6">{p.collectHeading}</h2>
          <ul className="text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
            {p.collect.map(item => (
              <li key={item.label}><strong>{item.label}</strong>：{item.body}</li>
            ))}
          </ul>

          <h2 className="font-bold mt-4">{p.notCollectHeading}</h2>
          <ul className="text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
            {p.notCollect.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h2 className="font-bold mt-4">{p.storageHeading}</h2>
          {p.storage.map(para => (
            <p key={para.slice(0, 24)} className="text-[var(--text-on-white-2)]">{para}</p>
          ))}

          <h2 className="font-bold mt-4">{p.shareHeading}</h2>
          <p className="text-[var(--text-on-white-2)]">{p.share}</p>

          <h2 className="font-bold mt-4">{p.e2eHeading}</h2>
          <p className="text-[var(--text-on-white-2)]">{p.e2e}</p>

          <h2 className="font-bold mt-4">{p.localHeading}</h2>
          <p className="text-[var(--text-on-white-2)]">{p.local}</p>

          <h2 className="font-bold mt-4">{p.rightsHeading}</h2>
          <p className="text-[var(--text-on-white-2)]">{p.rights}</p>

          <details className="mt-4" data-testid="privacy-tech-glossary">
            <summary className="font-kanji text-xs cursor-pointer text-[var(--text-muted-on-light)]">
              {p.glossarySummary}
            </summary>
            <ul className="mt-2 text-[11px] text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
              {p.glossary.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>

          <p className="text-[var(--text-on-white-2)] mt-6">{p.lastUpdated}</p>
        </MisakaCard>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link to="/" className="nav-pill">{p.backHome}</Link>
          <Link to="/tos" className="nav-pill">{p.viewTerms}</Link>
        </div>
      </div>
    </div>
  )
}
