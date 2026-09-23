import type { SessionMessage } from '@/types/hermes'

import type { ChatMessage, TranscriptSourceRow } from './types'

export function storedSourceRow(message: SessionMessage): TranscriptSourceRow {
  const rowId = message.row_id ?? (typeof message.id === 'number' ? message.id : undefined)

  return {
    ...(rowId !== undefined ? { rowId } : {}),
    ...(message.display_order !== undefined ? { displayOrder: message.display_order } : {})
  }
}

export function sourceRowOccurrence(row: TranscriptSourceRow): number | undefined {
  return row.displayOrder ?? row.rowId
}

/** Physical addresses remain available for reactions, rewind and older backends. */
export function transcriptRowIds(message: ChatMessage): number[] {
  const ids = message.parts.flatMap(part => (part.sourceRowId !== undefined ? [part.sourceRowId] : []))

  return message.rowId === undefined ? ids : [message.rowId, ...ids]
}

/** Compaction copies a row but preserves its first-generation display order. */
export function transcriptOccurrenceIds(message: ChatMessage): number[] {
  const ids = message.parts.flatMap(part => {
    const id = part.sourceDisplayOrder ?? part.sourceRowId

    return id === undefined ? [] : [id]
  })

  const id = message.displayOrder ?? message.rowId

  return id === undefined ? ids : [id, ...ids]
}

export function sameTranscriptOccurrence(local: ChatMessage, authoritative: ChatMessage): boolean {
  if (local.role !== authoritative.role) {
    return false
  }

  const authoritativeIds = transcriptOccurrenceIds(authoritative)

  return transcriptOccurrenceIds(local).some(id => authoritativeIds.includes(id))
}

/** Unknown identity remains eligible for legacy live projection, not a match. */
export function conflictingTranscriptIdentity(local: ChatMessage, authoritative: ChatMessage): boolean {
  const localIds = transcriptOccurrenceIds(local)
  const authoritativeIds = transcriptOccurrenceIds(authoritative)

  return Boolean(localIds.length && authoritativeIds.length && !localIds.some(id => authoritativeIds.includes(id)))
}
