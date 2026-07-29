/** Settings surface labels. */

export const settings = {
  title: '设置',
  description: '连接协助、音效与关于本应用的设置',
  closeAria: '关闭设置',

  tabs: {
    turn: '连接',
    sound: '音效',
    about: '关于',
  } as const,

  // Master switch — user-facing name for TURN
  serverAssisted: '服务器协助连接',
  serverAssistedDesc: '同时控制服务器自动下发和下方手工添加的服务器',
  forceRelay: '强制服务器协助（仅测试）',
  forceRelayNeedSwitch: '需要先启用服务器协助连接',
  forceRelayNoServer: '当前没有可用的协助服务器，开启后将无法建立连接',
  forceRelayHint: '仅测试用：强制所有连接经过服务器协助',

  advanced: '高级设置',
  techDiagnostics: '技术诊断',

  networkType: '网络类型检测',
  detecting: '检测中…',
  redetect: '重新检测',
  startDetect: '开始检测',
  natDetectFailed: '无法完成网络类型检测。请确认浏览器未屏蔽设备直连功能，然后重试。',
  publicMappings: (n: number) => `${n} 个公网映射`,
  natNeedAssist:
    '建议在下方启用服务器协助连接，否则与同类网络的对端可能无法直连。',

  autoIssue: '服务器自动下发',
  statusDisabled: '已停用',
  statusUnconfigured: '未配置',
  statusUnavailable: '暂不可用',
  statusIssued: '已下发',
  statusPending: '待下发',
  credentialRemaining: (seconds: number, ttl: number) =>
    `剩余 ${seconds} 秒 · 有效期 ${ttl} 秒`,
  relayTemporarilyUnavailable:
    '中继服务暂时不可用。请稍后重试，或使用下方经过验证的手工服务器。',
  cannotFetchCredential: '暂时无法获取中继凭证，可点击下方按钮重试。',
  cannotFetchStatus: '暂时无法获取中继服务状态',
  retry: '重试',
  issueCredential: '下发中继凭证',
  issuing: '下发中…',
  issueFailed: '暂时无法获取中继凭证。请检查网络后重试。',

  intro:
    '服务器配置好协助连接后会自动下发短时效凭证；下方手工添加的服务器在启用状态下生效。关闭「服务器协助连接」后，自动下发和手工服务器都不会用于连接。',

  // Manual server list (advanced)
  addServer: '添加服务器',
  editServer: '编辑服务器',
  serverUrl: '服务器地址',
  serverUrlPlaceholder: 'turn:example.com:3478?transport=udp',
  serverUrlInvalid: '请输入以 turn: 或 turns: 开头的服务器地址',
  username: '用户名',
  password: '密码',
  enable: '启用',
  disable: '禁用',
  test: '测试',
  testing: '测试中…',
  edit: '编辑',
  delete: '删除',
  save: '保存',
  cancel: '取消',
  add: '+ 添加',
  reachable: '✓ 可达',
  unreachable: '✗ 不可达',
  untested: '未测试',
  testFailed: '测试无法启动。请检查地址格式后重试。',

  // Delete confirm
  deleteConfirmTitle: '删除此协助服务器？',
  deleteConfirmBody: (url: string) =>
    `将删除「${url}」。若这是唯一可用的协助配置，且凭据无法重新获取，在严格网络下可能无法再连接。`,
  keep: '保留',
  confirmDelete: '确认删除',

  // NAT user-facing labels (tech terms in expandable diagnostics only)
  nat: {
    open: '可直接连接',
    cone: '可直接连接',
    'cone-v6': '仅支持新式网络地址',
    symmetric: '需要服务器协助',
    blocked: '网络限制较严格',
    unknown: '未知',
  } as const,

  // Sound
  soundIntro: '扫码、传输完成、错误提示会播放短音效。设置只保存在本机。',
  soundEnable: '启用操作音效',
  soundScan: '扫码',
  soundComplete: '完成',
  soundError: '错误',
  fileNotify: '文件接收通知',
  authorizeNotify: '授权通知',

  // About
  aboutCredit: '© Master Huang · Misaka Network',
  aboutBody:
    '文件在浏览器之间端到端加密传输；直连失败时，流量可能经过服务器自动下发的协助连接或你配置的中继。信令会处理会话、网络地址安全状态和聚合传输统计，部分安全/额度数据会跨重启保留。',
  github: '查看源代码（GitHub）',
  terms: '服务条款',
  privacy: '隐私政策',
} as const
