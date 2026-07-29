/** Transfer panel status, actions and cancel-confirmation copy. */

export const transfer = {
  panelTitle: '传输面板',
  panelSubtitle: '当前文件任务',
  noTasks: '暂无传输任务',

  pause: '⏸ 暂停',
  cancel: '✕ 取消',
  resume: '▶ 继续',
  remove: '✕ 移除',
  retry: '重试',
  resendToPeer: '再发文件给此设备',
  waitingSaveAck: '等待对方保存确认',
  paused: '已暂停',
  pending: '⏳ 等待中',

  saved: '已保存',
  delivered: '已送达',
  recvToFsa: '已保存到所选位置',
  recvDone: '接收完成',
  fsaHint: '文件已写入所选位置',
  downloadInChat: '请在消息中下载',

  failed: '✗ 失败',
  unsupported: '✗ 浏览器不支持',

  directionSend: '发送',
  directionRecv: '接收',

  progressLabel: (direction: 'send' | 'recv', fileName: string) =>
    `${direction === 'send' ? '发送' : '接收'} ${fileName} 的进度`,

  cancelConfirmTitle: '取消传输？',
  cancelConfirmContinue: '继续传输',
  cancelConfirmAction: '确认取消',
  cancelPartialWarning: '已接收部分将被删除',
  /** Shown when the cancel dialog is confirmed after the transfer already finished. */
  cancelAlreadyFinished: '该传输已结束，无需取消',

  cancelConfirmBody: (opts: {
    fileName: string
    direction: 'send' | 'recv'
    percent: number
  }) => {
    const dir = opts.direction === 'send' ? '发送' : '接收'
    return `即将取消「${opts.fileName}」的${dir}（已完成 ${opts.percent}%）。`
  },

  storageFull: ({ fileName }: { fileName?: string } = {}) =>
    fileName
      ? `设备存储空间不足，无法保存「${fileName}」。请清理空间后重试`
      : '设备存储空间不足，请清理空间后重试',
  connectionLost: '连接已中断，请重新连接后重试',
  encryptionFailed: '安全连接建立失败，请重新连接',
  rateLimited: '操作过于频繁，请稍后再试',
  sessionExpired: '会话已失效，请重新接入后再试',
  genericFailure: '传输失败，请检查网络连接后重试',
} as const
