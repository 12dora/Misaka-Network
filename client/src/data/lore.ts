export const QUOTES = [
  '御坂望着手中的青蛙玩偶——御坂如此报告道。',
  '这种事情，御坂如此问道。',
  '御坂感到了一丝奇妙的不协调感——御坂如此分析道。',
  '网络连接已稳定，脑波同步率 98.7%——御坂如此汇报道。',
  '检测到未知节点接入，御坂感到了好奇——御坂如此说道。',
  '数据流注入完成，任务成功——御坂如此确认道。',
  '这就是御坂网络的力量——御坂如此骄傲地宣告道。',
  '御坂正在处理 20,001 个节点的同步请求——御坂如此忙碌着。',
]

export interface CharacterData {
  nodeId: number
  kanji: string
  name: string
  furigana: string
  title: string
  desc: string
  quote?: string
}

export const CHARACTERS: CharacterData[] = [
  {
    nodeId: 0,
    kanji: '琴',
    name: '御坂美琴',
    furigana: 'みさか みこと',
    title: '电击使 · 超电磁炮',
    desc: '学园都市第三位 LV5 超能力者。御坂妹妹的 DNA 提供者，御坂网络的原型人格。',
    quote: '这种程度就别来找我了！',
  },
  {
    nodeId: 10032,
    kanji: '妹',
    name: '御坂 10032 号',
    furigana: 'みさか いちまんさんじゅうに ごう',
    title: '青蛙玩偶持有者',
    desc: '御坂妹妹中最为人熟知的个体，常以「御坂如此…道」的固定句型表达意见，是御坂网络中最活跃的节点之一。',
    quote: '这种事情，御坂如此问道。',
  },
  {
    nodeId: 20001,
    kanji: '止',
    name: 'Last Order（御坂 20001 号）',
    furigana: 'ラストオーダー / みさか にまんいち ごう',
    title: '管制人格 · 网络管理者',
    desc: '御坂网络的核心节点，承担全网的管制与协调职能。以独特的「咪萨咖」音调为特征，天真烂漫却承载着整个网络。',
    quote: '咪萨咖咪萨咖～♪',
  },
  {
    nodeId: 19090,
    kanji: '影',
    name: '御坂 19090 号',
    furigana: 'みさか いちまんきゅうせんきゅうじゅう ごう',
    title: '影子节点',
    desc: '在暗处默默维护网络稳定的实验体。节点编号在原著中有着特殊意义，承担着不为人知的重要任务。',
  },
]

export const LORE_LOG = [
  { date: '20XX/03/21', event: '御坂网络正式建立，首批实验体接入。' },
  { date: '20XX/04/14', event: '御坂 10032 号首次进入第七学区，成为网络关键节点。' },
  { date: '20XX/06/02', event: '御坂网络连接数突破 10,000。' },
  { date: '20XX/07/28', event: '检测到管制人格（Last Order）接入，全网同步。' },
  { date: '20XX/08/15', event: '网络发生大规模脑量子波干扰，临时断线 03:22。' },
  { date: '20XX/09/30', event: '御坂网络连接数突破 20,000，接近原著上限。' },
  { date: '20XX/10/05', event: '御坂 20001 号「打止」成为全网最高权限管制人格。' },
]

const RANDOM_DESCS = [
  '正在执行标准巡逻任务，暂无特殊记录。',
  '该实验体专注于数据处理，网络贡献值 A 级。',
  '该节点是御坂网络中稳定运行的成员之一，任务履行率 99.2%。',
  '偶尔会在第七学区便利店附近被目击，手持青蛙玩偶。',
  '负责协调网络中部分节点的同步频率，工作效率优秀。',
  '该实验体拥有超过平均水平的数据处理速度，网络优化贡献突出。',
]

const KNOWN: Record<number, string> = {
  9982:  '御坂 9982 号——与某位研究员有过一次相遇，成为整个事件的起点。原著中具有重要意义的节点。',
  10031: '御坂 10031 号——10032 号的前一个编号，紧密关联实验进程。',
  10032: '御坂 10032 号——青蛙玩偶持有者，御坂妹妹中最为人熟知的个体。曾与上条当麻有过难忘的邂逅。',
  19090: '御坂 19090 号——在暗处守护网络稳定的影子节点，原著中有着特殊地位。',
  20001: 'Last Order（御坂 20001 号）——管制人格，御坂网络的核心节点与最高权限持有者。「咪萨咖咪萨咖～」',
}

export function getCharacterByNodeId(nodeId: number): string {
  if (KNOWN[nodeId]) return `御坂 ${nodeId} 号\n${KNOWN[nodeId]}`
  const desc = RANDOM_DESCS[nodeId % RANDOM_DESCS.length]
  return `御坂 ${nodeId} 号\n${desc}`
}
