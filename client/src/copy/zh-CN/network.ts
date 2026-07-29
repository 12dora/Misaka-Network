/** Device, connection status and QR-related functional copy. */

export const network = {
  // Primary noun on functional pages
  device: '设备',
  devices: '设备',
  nodeId: '节点编号',
  deviceOrdinal: (n: number) => `设备 ${n}`,

  // Unified status vocabulary
  status: {
    online: '连接',
    transferring: '正在传输',
    connecting: '正在连接',
    reconnecting: '正在恢复连接',
    offline: '已断开',
    notJoined: '未接入',
  } as const,

  // Peer badge labels (functional pages — not ACGN lore)
  peerStatus: {
    online: '连接',
    transferring: '正在传输',
    connecting: '正在连接',
    reconnecting: '正在恢复连接',
    unauthorized: '通行码错误',
    offline: '已断开',
  } as const,

  // Channel labels shown in main flow
  channel: {
    direct: '局域网直连',
    stun: '互联网直连',
    relay: '服务器协助连接',
    ws: '临时备用连接',
  } as const,

  channelTypeRaw: {
    direct: 'direct',
    stun: 'stun',
    relay: 'relay',
    ws: 'ws',
  } as const,

  e2eEncrypted: '端到端加密',
  connectionMethod: '连接方式',
  techDiagnostics: '技术诊断',
  restoringConnection: '正在恢复连接…',
  openServerAssisted: '打开“服务器协助连接”',
  natUnreachable:
    '当前网络可能阻止设备直连，请打开服务器协助连接。',

  // Radar / empty states
  nodeRadar: '设备列表',
  foundSameIdentity: (status: string) => `发现同身份设备 · ${status}`,
  noOtherDevices: '网络中暂无其他设备',
  shareToJoin: '分享二维码或链接给另一台设备即可接入',
  showMyQr: '显示我的二维码',
  copyLink: '复制链接',
  linkCopied: '链接已复制到剪贴板',
  copyFailed: (detail?: string) =>
    detail ? `复制失败：${detail}` : '复制失败，请稍后再试',

  selectDevice: (nodeId: number, sidTag?: string, status?: string, unread?: string) => {
    const parts = [`选择御坂 ${nodeId} 号设备`]
    if (sidTag) parts.push(`会话 ${sidTag}`)
    if (status) parts.push(status)
    if (unread) parts.push(unread)
    return parts.join('，')
  },
  unreadSummary: (message: number, file: number) =>
    `未读消息 ${message}，未读文件 ${file}`,

  sessionChannel: '会话',
  chatPlaceholder: '输入消息…',
  chatInputLabel: '聊天输入框',
  you: '你',
  peer: '对方',

  peerConnected: '连接成功。现在可以发送消息或文件。',
  peerReconnecting: '正在恢复连接，稍后即可发送消息或文件。',
  peerOffline: '尚未连接。请检查网络，或点击上方的重连。',
  peerConnecting: '正在连接…',

  pendingItems: (n: number) => `待发送 ${n} 个项目`,
  removeItem: (name: string) => `移除 ${name}`,

  tabs: {
    radar: '设备',
    channel: '会话',
    tasks: '任务',
  } as const,

  bottomBar: {
    tasks: '任务',
    channel: '会话',
    qr: '二维码',
  } as const,

  qr: {
    myQr: '我的二维码',
    myAccessQr: '我的接入二维码',
    accessQrForDevices: '用于让其他设备接入当前节点',
    showMyQr: '显示我的二维码',
    scanNode: '扫描设备二维码',
    scanDescription: '仅扫描御坂网络接入码',
    nodeQr: '设备二维码',
    accessQr: '接入二维码',
    refreshQr: '刷新二维码',
    refreshing: '刷新中…',
    generating: '生成中…',
    copyLink: '复制链接',
    linkCopied: '链接已复制',
    copyFailedHelp: '无法复制链接。请长按下方链接复制，或使用系统分享。',
    systemShare: '系统分享',
    close: '关闭',
    shareTitle: '御坂网络接入链接',
    passCode: '通行码',
    currentDevice: '当前设备',
    accessLink: '接入链接',
    tokenNoPasscode:
      '链接仅包含一次性接入令牌，不包含可重复使用的通行码。扫码设备仍需单独输入通行码。',
    /** Primary UI — never include HTTP status codes. */
    tokenFailed: '二维码凭证获取失败，请稍后再试',
    tokenRenderFailed: '二维码渲染失败，请刷新重试',
    pasteJoinLink: '粘贴本站生成的接入链接',
    expiresBefore: (time: string) => `${time} 前有效`,
    misakaNumber: (nodeId: number) => `御坂 ${nodeId} 号`,
  },

  scan: {
    cameraFeature: '摄像头功能',
    needSecureContext: '需要安全连接（HTTPS）或本机开发地址才能使用摄像头',
    unsupported: '此浏览器不支持摄像头功能',
    permissionDenied: '摄像头权限被拒绝，请在浏览器设置中允许',
    notFound: '未检测到摄像头设备',
    inUse: '摄像头被其他应用占用，请先关闭再试',
    overconstrained: '当前设备不支持所选摄像头方向，正在切换…',
    security: '需要安全连接（HTTPS）或本机开发地址才能使用摄像头',
    aborted: '摄像头启动被中断，请重试',
    genericFail: '摄像头启动失败，请重试或改用下方链接接入',
  },

  emptyDrop: '请先在「设备」页选择目标设备，再拖入文件',
  reconnectFailed: '重连失败，请稍后再试',
  fanoutFailed: '群发失败，请稍后再试',
  cannotResume: '无法继续该传输',
  fanoutAllDevices: (n: number) => `📡 群发到所有在线设备（${n}）`,
  fanoutAllDevicesShort: '📡 群发文件到全部设备',
  selectFile: '📁 选择文件',
  selectFolder: '🗂 选择文件夹',
  multiSelectHint: '支持多选、拖拽多个文件和文件夹队列',
  targetMisaka: (nodeId: number) => `目标：御坂 ${nodeId} 号`,
  reconnectNow: '立即重连',
  reconnectThisDevice: '立即重连此设备',
  reconnecting: '正在重连…',
  connectionDropped: '连接已断开 — 请检查网络或打开服务器协助连接',
  openSettings: '打开设置',
  selectDeviceFirst: '请先在「设备」页选择目标设备',
  selectDeviceThenSend: '选择后即可打开会话并发送文件或消息',

  icePath: 'ICE 路径',
  gatherTime: '采集时间',
  copyDiagnostics: '复制诊断',
  notRecorded: '未记录',
  diagnosticsCopied: '诊断信息已复制到剪贴板',
  diagnosticsCopyFailed: '复制失败，请手动选取诊断文本',
  misakaNumber: (nodeId: number) => `御坂 ${nodeId} 号`,
  diagLineNode: (nodeId: number, sidTag: string) =>
    `节点: 御坂 ${nodeId} 号 (#${sidTag})`,
  diagLineChannel: (label: string) => `信道: ${label}`,
  diagLineIce: (path: string) => `ICE路径: ${path}`,
  diagLineGather: (when: string) => `采集时间: ${when}`,
  diagLineStatus: (status: string) => `状态: ${status}`,
  sessionIdLabel: (id: string) => `会话：${id}`,
  channelTypeLabel: (type: string) => `信道类型：${type} · DTLS + AES-GCM`,
  sending: '发送中…',
  send: '发送',
  clearPending: '清空',
  dismissHint: '忽略提示',

  // Chat delivery-status tooltips (WhatsApp-style ticks)
  delivery: {
    sending: '发送中',
    sent: '已发送',
    delivered: '已送达',
    failedRetry: '发送失败，点击重试',
  } as const,
} as const

export type NetworkStatusKey = keyof typeof network.status
