/**
 * Small helpers shared by runtime composition and store actions.
 */
import type { ChannelMessage } from '@/types'
import { selectPrunedChatMessages } from './selectors'
import { retireDownloadUrls } from './download-artifacts'

export function pruneChatMessages(msgs: ChannelMessage[]): ChannelMessage[] {
  const { kept, retiredUrls } = selectPrunedChatMessages(msgs)
  retireDownloadUrls(retiredUrls)
  return kept
}
