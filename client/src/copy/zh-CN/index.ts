import { common, formatDurationZhCN, formatRange, formatUptimeZhCN } from './common'
import { auth } from './auth'
import { network } from './network'
import { transfer } from './transfer'
import { settings } from './settings'
import { stats } from './stats'
import { pageMeta, titleForPath, DEFAULT_PAGE_TITLE } from './pageMeta'
import { legal } from './legal'
import { acgn } from './acgn'

export const zhCN = {
  common,
  auth,
  network,
  transfer,
  settings,
  stats,
  pageMeta,
  legal,
  acgn,
  titleForPath,
  DEFAULT_PAGE_TITLE,
  formatDurationZhCN,
  formatUptimeZhCN,
  formatRange,
} as const

export {
  common,
  auth,
  network,
  transfer,
  settings,
  stats,
  pageMeta,
  legal,
  acgn,
  titleForPath,
  DEFAULT_PAGE_TITLE,
  formatDurationZhCN,
  formatUptimeZhCN,
  formatRange,
}

export default zhCN
