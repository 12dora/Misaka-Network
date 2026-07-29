/** ACGN / lore page section chrome (zh-CN). Character/lore content stays in data/lore. */

export const acgn = {
  heroTagline: '连接全部御坂妹妹的脑量子波共享网络',
  heroTaglineSub: '连接所有御坂妹妹的脑量子波共享网络',
  learnMore: '了解更多',
  aboutTitle: '关于御坂网络',
  aboutFurigana: '关于御坂网络',
  aboutLead: {
    name: '御坂网络',
    mid: '是连接全部御坂妹妹的',
    accent: '脑量子波',
    after: '共享网络。',
  },
  aboutBody: {
    before: '在《某科学的超电磁炮》设定中，约 20,000 名',
    accent1: '实验体',
    mid: '通过脑量子波互联，形成',
    accent2: '分布式',
    after: '意识网络。每个妹妹既是独立个体，又能共享视觉、记忆、知识。',
  },
  aboutClosing:
    '本应用借用这一设定作为美学骨架，构建点对点文件传输工具：每位用户都是一个「节点」，节点之间通过加密信道直接共享数据——文件本体永不经过服务器。',
  sections: {
    characters: { kanji: '体', title: '实验体档案', furigana: '实验体档案' },
    easterEggs: { kanji: '戯', title: '彩蛋功能', furigana: '彩蛋功能' },
    timeline: { kanji: '史', title: '世界观时间线', furigana: '时间线' },
  },
  quoteGenerator: '妹妹语录生成器',
  regenerate: '↻ 重新生成',
  nodeQuery: '实验体编号查询',
  nodeQueryLabel: '实验体编号，范围 1–20001',
  nodeQueryPlaceholder: '1–20001',
  query: '查询',
  nodeOutOfRange: '节点编号范围为 1–20001',
  loreLog: '网络日志',
  resumeScroll: '▶ 继续滚动',
  pauseScroll: '⏸ 暂停滚动',
  heroAlt: '御坂美琴',
} as const
