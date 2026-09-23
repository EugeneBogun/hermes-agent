import { sourceRowOccurrence } from './occurrence-identity'
import { normalizeWs as normalizedText } from './parts'
import type { ChatMessage, ChatMessagePart } from './types'

function sameOccurrencePart(stored: ChatMessagePart, local: ChatMessagePart): boolean {
  const storedId = stored.sourceDisplayOrder ?? stored.sourceRowId
  const localId = local.sourceDisplayOrder ?? local.sourceRowId

  if (storedId !== undefined && localId !== undefined && storedId !== localId) {
    return false
  }

  if (stored.type === 'tool-call' && local.type === 'tool-call') {
    return Boolean(stored.toolCallId) && stored.toolCallId === local.toolCallId
  }

  if ((stored.type === 'text' || stored.type === 'reasoning') && local.type === stored.type) {
    return normalizedText(stored.text) === normalizedText(local.text)
  }

  return false
}

function assistantSuffix(message: ChatMessage, consumed: number): ChatMessage {
  const parts = message.parts.slice(consumed)
  const firstId = parts[0].sourceDisplayOrder ?? parts[0].sourceRowId
  const rowIndex = message.serverRows?.findIndex(row => sourceRowOccurrence(row) === firstId) ?? -1

  const sharesSource = message.parts
    .slice(0, consumed)
    .some(part => (part.sourceDisplayOrder ?? part.sourceRowId) === firstId)

  if (firstId !== undefined && rowIndex >= 0 && !sharesSource) {
    const serverRows = message.serverRows!.slice(rowIndex)
    const first = serverRows[0]

    return {
      ...message,
      id: `stored-${firstId}-assistant`,
      rowId: first.rowId,
      displayOrder: first.displayOrder,
      parts,
      serverRows,
      serverRowSpan: serverRows.length,
      timestamp: parts[0].timestamp,
      reactions: undefined
    }
  }

  // A legacy or partially written source has no independently addressable
  // suffix. Preserve it as local output, never as the covered row again:
  // retention must not release bytes it cannot refetch or count guessed spans.
  return {
    ...message,
    id: `assistant-stream-recovered-${message.id}-${consumed}`,
    parts,
    rowId: undefined,
    displayOrder: undefined,
    serverRows: undefined,
    serverRowSpan: undefined,
    reactions: undefined,
    durableComplete: false,
    persistedTurn: undefined
  }
}

/** Subtract an ordered, tool-anchored prefix within an already matched user
 * interval. Hydration can fold several live bubbles into one durable row;
 * bubble ordinals and equal text alone cannot establish that coverage. */
export function withoutCoveredAssistantPrefix(stored: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const parts = stored.flatMap(message => (message.role === 'assistant' ? message.parts : []))
  let cursor = 0
  let anchored = false
  let stopped = false
  const remaining: ChatMessage[] = []

  for (const message of local) {
    if (stopped || message.role !== 'assistant' || message.error) {
      stopped = true
      remaining.push(message)

      continue
    }

    let consumed = 0

    for (const part of message.parts) {
      if (!parts[cursor] || !sameOccurrencePart(parts[cursor], part)) {
        break
      }

      anchored ||= part.type === 'tool-call'
      cursor += 1
      consumed += 1
    }

    if (consumed < message.parts.length) {
      stopped = true
      remaining.push(consumed ? assistantSuffix(message, consumed) : message)
    }
  }

  // A coincidentally equal paragraph, without the same tool occurrence after
  // it, is insufficient evidence to remove anything.
  return anchored ? remaining : local
}
