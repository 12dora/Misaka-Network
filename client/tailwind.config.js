/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '390px',
      },
      colors: {
        'bg-primary':    'var(--bg-primary)',
        'bg-deep':       'var(--bg-deep)',
        'bg-soft':       'var(--bg-soft)',
        'surface':       'var(--surface)',
        'surface-cream': 'var(--surface-cream)',
        'surface-tint':  'var(--surface-tint)',
        'accent-cyan':   'var(--accent-cyan)',
        'state-success': 'var(--state-success)',
        'state-warn':    'var(--state-warn)',
        'state-danger':  'var(--state-danger)',
        'on-blue':       'var(--text-on-blue)',
        'on-blue-2':     'var(--text-on-blue-2)',
        'on-white':      'var(--text-on-white)',
        'on-white-2':    'var(--text-on-white-2)',
        'muted':         'var(--text-muted)',
      },
      fontFamily: {
        jp:    ['Shippori Mincho', 'Noto Serif JP', 'serif'],
        kanji: ['Noto Sans JP', 'Noto Sans SC', 'sans-serif'],
        body:  ['Noto Sans SC', 'Noto Sans JP', 'system-ui', 'sans-serif'],
        mono:  ['IBM Plex Mono', 'Roboto Mono', 'monospace'],
      },
      boxShadow: {
        card:  'var(--shadow-card)',
        float: 'var(--shadow-float)',
      },
      borderColor: {
        card:   'var(--border-card)',
        strong: 'var(--border-strong)',
      },
    },
  },
  plugins: [],
}
