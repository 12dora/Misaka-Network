import { Link } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaCard from '@/components/ui/MisakaCard'
import { legal } from '@/copy/zh-CN/legal'

export default function Terms() {
  const t = legal.terms
  return (
    <div className="px-4" style={{ background: 'var(--bg-primary)', minHeight: '100dvh', paddingTop: 'calc(var(--nav-h-total) + 1rem)', paddingBottom: 'calc(5rem + var(--safe-bottom))' }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <MisakaKanjiBlock char="条" size="md" />
          <h1 className="font-kanji font-bold text-xl text-white">{t.title}</h1>
        </div>

        <MisakaCard padding="md" className="space-y-4 font-kanji text-sm leading-relaxed">
          <p>{t.intro}</p>

          {t.sections.map((section, i) => (
            <div key={section.heading}>
              <h2 className={`font-bold ${i === 0 ? 'mt-6' : 'mt-4'}`}>{section.heading}</h2>
              <p className="text-[var(--text-on-white-2)]">{section.body}</p>
            </div>
          ))}

          <details className="mt-4" data-testid="terms-tech-glossary">
            <summary className="font-kanji text-xs cursor-pointer text-[var(--text-muted-on-light)]">
              {t.glossarySummary}
            </summary>
            <ul className="mt-2 text-[11px] text-[var(--text-on-white-2)] list-disc pl-5 space-y-1">
              {t.glossary.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>

          <p className="text-[var(--text-on-white-2)] mt-6">{t.lastUpdated}</p>
        </MisakaCard>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link to="/" className="nav-pill">{t.backHome}</Link>
          <Link to="/privacy" className="nav-pill">{t.viewPrivacy}</Link>
        </div>
      </div>
    </div>
  )
}
