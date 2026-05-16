import { useId, type CSSProperties } from 'react'
import { publicAssetUrl } from '@/lib/appBase'

const HERO_TITLE = publicAssetUrl('assets/misaka-title.webp')

export default function MisakaHeroTitle({ width }: { width: CSSProperties['width'] }) {
  const outlineId = useId().replace(/:/g, '')

  return (
    <svg
      className="block select-none pointer-events-none"
      role="img"
      aria-label="とある科学 御坂网络"
      viewBox="-40 -40 1616 1104"
      style={{
        width,
        height: 'auto',
        overflow: 'visible',
      }}
    >
      <defs>
        <filter
          id={outlineId}
          x="-80"
          y="-80"
          width="1696"
          height="1184"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feMorphology in="SourceAlpha" operator="dilate" radius="12" result="expanded" />
          <feFlood floodColor="#fff" result="white" />
          <feComposite in="white" in2="expanded" operator="in" result="outline" />
          <feMerge>
            <feMergeNode in="outline" />
          </feMerge>
        </filter>
      </defs>
      <image
        href={HERO_TITLE}
        x="0"
        y="0"
        width="1536"
        height="1024"
        preserveAspectRatio="xMidYMid meet"
        filter={`url(#${outlineId})`}
      />
      <image
        href={HERO_TITLE}
        x="0"
        y="0"
        width="1536"
        height="1024"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  )
}
