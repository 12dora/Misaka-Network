/** Per-route document.title values. */

export const pageMeta: Record<string, { title: string; description?: string }> = {
  '/': {
    title: '御坂网络',
    description: '无需注册、注重隐私、可跨设备使用的点对点文件传输工具',
  },
  '/network': {
    title: '网络 · 御坂网络',
  },
  '/acgn': {
    title: '作品设定 · 御坂网络',
  },
  '/join': {
    title: '接入设备 · 御坂网络',
  },
  '/tos': {
    title: '服务条款 · 御坂网络',
  },
  '/privacy': {
    title: '隐私政策 · 御坂网络',
  },
}

export const DEFAULT_PAGE_TITLE = '御坂网络'

export function titleForPath(pathname: string): string {
  return pageMeta[pathname]?.title ?? DEFAULT_PAGE_TITLE
}
