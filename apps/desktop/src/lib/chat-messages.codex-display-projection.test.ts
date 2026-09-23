import { expect, it, vi } from 'vitest'

import { graftRefreshedTailOntoBackfill, mergeOlderTranscriptPage } from '@/app/chat/transcript-backfill'
import { boundRetainedTranscript, TRANSCRIPT_RETAIN_BUDGET } from '@/app/chat/transcript-retention'
import { preserveEquivalentTranscript } from '@/app/session/hooks/use-session-actions/utils'
import type { SessionMessage } from '@/types/hermes'

import { type ChatMessage, chatMessageText, dedupeRepeatedTextInParts, toChatMessages } from './chat-messages'
import {
  persistInFlightTurnState,
  readInFlightTurnJournal,
  recoverInFlightTurnJournal,
  resetInFlightTurnJournalStateForTests
} from './inflight-turn-journal'

it('preserves distinct equal commentary occurrences within one durable row (synthetic fixture)', () => {
  const row: SessionMessage = {
    id: 2,
    role: 'assistant',
    content: 'Final answer.',
    display_commentary: ['Checking files.', 'Checking files.']
  }

  const [visible] = toChatMessages([row])
  expect(visible.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([
    ...row.display_commentary!,
    row.content
  ])
  const current = [visible]
  const repeated = toChatMessages([row])
  expect(preserveEquivalentTranscript(current, repeated)).toBe(current)
  expect(dedupeRepeatedTextInParts([...visible.parts, ...repeated[0].parts])).toEqual(visible.parts)
  expect(dedupeRepeatedTextInParts(visible.parts)).toBe(visible.parts)

  // Equal text must not hide a change to the authored occurrence order.
  const swapped = [{ ...visible, parts: [visible.parts[1], visible.parts[0], visible.parts[2]] }]
  expect(preserveEquivalentTranscript(current, swapped)).toBe(swapped)
})

it('retains commentary occurrence identity through journal recovery and page overlap (synthetic fixture)', () => {
  vi.useFakeTimers()
  localStorage.clear()
  resetInFlightTurnJournalStateForTests()

  try {
    const rows: SessionMessage[] = [
      { id: 1, display_order: 1, role: 'user', content: 'Inspect' },
      {
        id: 2,
        display_order: 2,
        role: 'assistant',
        content: 'Opening the file.',
        tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{}' } }]
      },
      { id: 3, display_order: 3, role: 'tool', tool_call_id: 'call', content: 'contents' },
      {
        id: 4,
        display_order: 4,
        role: 'assistant',
        content: 'Final answer.',
        display_commentary: ['Checking files.', '', 'Checking files.']
      }
    ]

    const hydrated = toChatMessages(rows)
    const originalParts = hydrated[1].parts.filter(part => part.type === 'text')
    const storedSessionId = 'synthetic-commentary-occurrences'
    persistInFlightTurnState({
      storedSessionId,
      messages: hydrated,
      streamId: hydrated[1].id,
      busy: true,
      awaitingResponse: false,
      turnStartedAt: 1000
    })
    vi.advanceTimersByTime(400)
    resetInFlightTurnJournalStateForTests()
    const snapshot = readInFlightTurnJournal(storedSessionId)!
    expect(snapshot.messages[1].parts.filter(part => part.type === 'text')).toEqual(originalParts)

    const restored = recoverInFlightTurnJournal(storedSessionId, hydrated.slice(0, 1))
    expect(restored.applied).toBe(true)
    expect(dedupeRepeatedTextInParts(restored.messages[1].parts)).toBe(restored.messages[1].parts)

    // Subtracting the durable tool prefix keeps both occurrences on the recovered suffix.
    const partialBase = toChatMessages(rows.slice(0, 3))
    const suffix = recoverInFlightTurnJournal(storedSessionId, partialBase).messages.at(-1)!
    expect(suffix.parts).toEqual(hydrated[1].parts.slice(-3))
    expect(suffix.parts.map(part => part.sourceCommentaryIndex)).toEqual([0, 2, undefined])

    const slack: ChatMessage = {
      id: 'slack',
      role: 'user',
      rowId: 1000,
      parts: Array.from({ length: TRANSCRIPT_RETAIN_BUDGET }, () => ({ type: 'text', text: '.' }))
    }

    const anchor: ChatMessage = { id: 'anchor', role: 'user', rowId: 1001, parts: [{ type: 'text', text: 'Later' }] }

    for (let start = 1; start < rows.length; start += 1) {
      const tail = toChatMessages(rows.slice(start).map(row => ({ ...row, id: Number(row.id) + 100 })))

      for (const merge of [mergeOlderTranscriptPage, graftRefreshedTailOntoBackfill]) {
        const merged = merge(tail, restored.messages)
        const textParts = merged[1].parts.filter(part => part.type === 'text')
        expect(textParts.map(part => part.text)).toEqual(originalParts.map(part => part.text))
        expect(textParts.map(part => part.sourceCommentaryIndex)).toEqual(
          originalParts.map(part => part.sourceCommentaryIndex)
        )
        expect(mergeOlderTranscriptPage(merged, restored.messages)).toBe(merged)
        expect(dedupeRepeatedTextInParts(merged[1].parts)).toBe(merged[1].parts)
        expect(boundRetainedTranscript([...merged, slack, anchor], anchor.id)).toMatchObject({
          released: true,
          releasedServerRows: rows.length,
          messages: [slack, anchor]
        })
      }
    }

    const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).find(key =>
      key?.endsWith(`:${storedSessionId}`)
    )!

    for (const invalidIndex of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = structuredClone(snapshot)
      Object.assign(invalid.messages[1].parts[0], { sourceCommentaryIndex: invalidIndex })
      localStorage.setItem(key, JSON.stringify(invalid))
      resetInFlightTurnJournalStateForTests()
      expect(readInFlightTurnJournal(storedSessionId)).toBeNull()
    }
  } finally {
    resetInFlightTurnJournalStateForTests()
    localStorage.clear()
    vi.useRealTimers()
  }
})

it('hydrates only authorized commentary and preserves genuine reasoning independently of equal public text', () => {
  const publicText = 'Inspecting the files.'

  const rawItems = [
    {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '<think>Private</think>Raw commentary' }]
    },
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Stale raw final' }]
    }
  ]

  const row: SessionMessage = {
    id: 2,
    display_order: 2,
    role: 'assistant',
    content: 'Canonical answer',
    reasoning: publicText,
    codex_message_items: JSON.stringify(rawItems),
    display_commentary: [publicText]
  }

  const before = JSON.stringify(row)
  const [visible] = toChatMessages([row])
  expect(visible.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([
    publicText,
    'Canonical answer'
  ])
  expect(visible.parts.filter(part => part.type === 'reasoning').map(part => part.text)).toEqual([publicText])
  expect(chatMessageText(visible)).not.toContain('Raw commentary')
  expect(JSON.stringify(row)).toBe(before)

  const [disabled] = toChatMessages([{ ...row, display_commentary: [] }])
  expect(chatMessageText(disabled)).toBe('Canonical answer')
  expect(disabled.parts.filter(part => part.type === 'reasoning').map(part => part.text)).toEqual([publicText])

  const [projected] = toChatMessages([{ ...row, reasoning: null, display_content: '' }])
  expect(chatMessageText(projected)).toBe(publicText)
  expect(projected.parts.some(part => part.type === 'reasoning')).toBe(false)
  expect(projected.parts.every(part => part.sourceDisplayOrder === 2 && part.sourceRowId === 2)).toBe(true)

  const hidden = toChatMessages([{ ...row, reasoning: null, display_kind: 'hidden' }])
  expect(hidden).toEqual([])
})
