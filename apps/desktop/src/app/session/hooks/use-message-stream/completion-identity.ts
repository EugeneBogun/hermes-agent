import type { PersistedTurn } from '@hermes/shared'

import type { ClientSessionState } from '@/app/types'
import type { ChatMessage } from '@/lib/chat-messages'
import { transcriptOccurrenceIds, transcriptRowIds } from '@/lib/chat-messages/occurrence-identity'

/** Receipt lookup is scoped to the routed runtime's own transcript. */
export function completionOccurrenceIndex(messages: ChatMessage[], receipt?: PersistedTurn | null): number {
  const rowId = receipt?.final_assistant_row_id
  const occurrenceId = receipt?.final_assistant_display_order ?? rowId

  if (typeof occurrenceId !== 'number') {
    return -1
  }

  return messages.findIndex(
    message =>
      message.role === 'assistant' &&
      (transcriptOccurrenceIds(message).includes(occurrenceId) ||
        (typeof rowId === 'number' && transcriptRowIds(message).includes(rowId)))
  )
}

/** Legacy/unknown rows may settle by continuity; conflicting known rows may not. */
export function canSettleCompletion(message: ChatMessage, receipt?: PersistedTurn | null): boolean {
  const occurrenceId = receipt?.final_assistant_display_order ?? receipt?.final_assistant_row_id

  return (
    typeof occurrenceId !== 'number' ||
    transcriptOccurrenceIds(message).length === 0 ||
    completionOccurrenceIndex([message], receipt) >= 0
  )
}

export function acceptedCompletionTurn(messages: ChatMessage[]): NonNullable<ClientSessionState['completionTurn']> {
  const assistants = messages.filter(message => message.role === 'assistant')

  return {
    previousMessageIds: assistants.map(message => message.id),
    previousOccurrenceIds: [...new Set(assistants.flatMap(transcriptOccurrenceIds))],
    previousRowIds: [...new Set(assistants.flatMap(transcriptRowIds))],
    currentMessageIds: []
  }
}

/** Seals and mid-turn user rows must not discard ownership of earlier output. */
export function ownCompletionMessage(
  state: ClientSessionState,
  messageId: string
): ClientSessionState['completionTurn'] {
  const turn = state.completionTurn ?? acceptedCompletionTurn([])

  return turn.currentMessageIds.includes(messageId)
    ? turn
    : { ...turn, currentMessageIds: [...turn.currentMessageIds, messageId] }
}

export function isPastCompletion(state: ClientSessionState | undefined, receipt?: PersistedTurn | null): boolean {
  if (!state) {
    return false
  }

  // Final-row ownership is independent of whether the whole turn persisted.
  const index = completionOccurrenceIndex(state.messages, receipt)
  const message = state.messages[index]

  const turn = state.completionTurn
  const rowId = receipt?.final_assistant_row_id
  const occurrenceId = receipt?.final_assistant_display_order ?? rowId

  // The accepted start supersedes every preceding assistant, even when its
  // prompt has not hydrated yet or an older row still looks pending/interim.
  if (
    turn &&
    ((message && turn.previousMessageIds.includes(message.id)) ||
      (typeof occurrenceId === 'number' && turn.previousOccurrenceIds.includes(occurrenceId)) ||
      (typeof rowId === 'number' && turn.previousRowIds.includes(rowId)))
  ) {
    return true
  }

  if (!message) {
    return false
  }

  if (
    message.id === state.streamId ||
    (state.turnLive && (state.busy || state.awaitingResponse) && turn?.currentMessageIds.includes(message.id))
  ) {
    return false
  }

  return (
    (!state.busy && !state.awaitingResponse) ||
    state.messages.slice(index + 1).some(row => row.role === 'user' || row.role === 'assistant')
  )
}
