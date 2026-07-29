/** Stats dashboard functional-surface copy (uses 设备, not lore nouns). */

export const stats = {
  sectionTitle: '网络运行情报',
  liveStatus: '实时服务状态',
  serviceStatus: '服务状态',
  fetchFailed: '暂时无法获取服务状态',
  retry: '重试',
  staleNotice: (time: string) => `数据更新于 ${time}，当前可能已过期`,
  loading: '加载中',
  cpuLoad: '运算负荷',

  cards: {
    onlineDevices: {
      label: '在线设备数',
      hint: '当前在线设备',
      unit: '台',
    },
    peakConcurrent: {
      label: '峰值并发连接',
      hint: '历史最高在线',
      unit: '台',
    },
    totalTransfers: {
      label: '累计传输次数',
      hint: '累计传输次数',
      unit: '次',
    },
    totalBytes: {
      label: '累计数据通量',
      hint: '累计传输体量',
      unit: '',
    },
    activeChannels: {
      label: '当前活跃信道',
      hint: '正在连接的信道',
      unit: '条',
    },
    uptimeLongest: {
      label: '最长设备在线',
      hint: '最长在线时长',
      unit: '',
    },
    uptimeService: {
      label: '信令服务运行时间',
      hint: '服务运行时长',
      unit: '',
    },
  },
} as const
