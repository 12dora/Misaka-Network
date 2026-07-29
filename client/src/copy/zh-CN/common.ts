/** Shared actions, punctuation helpers and duration formatting. */

export const common = {
  retry: '重试',
  cancel: '取消',
  close: '关闭',
  copy: '复制',
  confirm: '确认',
  continue: '继续',
  remove: '移除',
  loading: '加载中…',
  loadingShort: '加载中',
  send: '发送',
  sending: '发送中…',
  clear: '清空',
  openSettings: '打开设置',
  dismissHint: '忽略提示',
  continueTransfer: '继续传输',
  confirmCancel: '确认取消',
  keep: '保留',
  ellipsis: '…',
  colon: '：',
  home: '首页',
  network: '网络',
  acgn: '作品设定',
  notJoined: '未接入',
  techGlossary: '技术术语表',
  techDetails: '技术详情 / 术语表',
  lastUpdated: (date: string) => `最后更新：${date}`,
  backHome: '← 返回首页',
  viewTerms: '查看服务条款',
  viewPrivacy: '查看隐私政策',
} as const

/** Format a millisecond duration with Chinese units. */
export function formatDurationZhCN(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h} 小时 ${m} 分钟`
  if (m > 0) return `${m} 分钟 ${s} 秒`
  return `${s} 秒`
}

/** Format seconds of uptime with Chinese units. */
export function formatUptimeZhCN(sec: number): string {
  if (sec === 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  if (d > 0) return `${d} 天 ${h} 小时`
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}

/** Format a closed range like 1–20001. */
export function formatRange(min: number, max: number): string {
  return `${min}–${max}`
}
