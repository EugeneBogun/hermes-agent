import { expect, it, vi } from 'vitest'

import { graftRefreshedTailOntoBackfill, mergeOlderTranscriptPage } from '@/app/chat/transcript-backfill'
import { boundRetainedTranscript, TRANSCRIPT_RETAIN_BUDGET } from '@/app/chat/transcript-retention'
import { preserveEquivalentTranscript, reconcileDurableHistory } from '@/app/session/hooks/use-session-actions/utils'
import { type ChatMessage, chatMessageText, toChatMessages } from '@/lib/chat-messages'
import {
  persistInFlightTurnState,
  readInFlightTurnJournal,
  recoverInFlightTurnJournal,
  resetInFlightTurnJournalStateForTests
} from '@/lib/inflight-turn-journal'
import type { SessionMessage } from '@/types/hermes'

it('keeps the same occurrences through compaction, shifted pages and a delayed live completion', () => {
  const rows = (generation: number): SessionMessage[] =>
    ['Earlier question', 'Earlier answer', 'Repeat', 'Same answer', 'Repeat', 'Same answer'].map((content, index) => ({
      id: generation + index + 1,
      display_order: index + 1,
      role: index % 2 ? 'assistant' : 'user',
      content,
      timestamp: index + 1
    }))

  const before = toChatMessages(rows(0))
  const compacted = toChatMessages(rows(100).slice(2))
  expect(compacted.map(message => message.id)).toEqual(before.slice(2).map(message => message.id))
  expect(compacted.map(message => message.rowId)).toEqual([103, 104, 105, 106])

  // The live receipt addresses the OLD physical row; compaction must not
  // turn its already-committed reply into an unrepresented local suffix.
  const live: ChatMessage = {
    ...before[3],
    id: 'assistant-stream-runtime',
    pending: false,
    durableComplete: true,
    persistedTurn: {
      complete: true,
      row_ids: [3, 4],
      user_row_id: 3,
      user_display_order: 3,
      final_assistant_row_id: 4,
      final_assistant_display_order: 4
    }
  }

  const reconciled = reconcileDurableHistory(compacted, [before[2], live])
  expect(reconciled.filter(message => message.role === 'assistant').map(chatMessageText)).toEqual([
    'Same answer',
    'Same answer'
  ])
  expect(reconciled.map(message => message.rowId)).toEqual(compacted.map(message => message.rowId))
  expect(mergeOlderTranscriptPage(compacted, before)).toEqual([...before.slice(0, 2), ...compacted])
  expect(graftRefreshedTailOntoBackfill(compacted, before)).toEqual([...before.slice(0, 2), ...compacted])
})

it('hydrates tool-only bubbles with stable source identities across page shifts and compaction', () => {
  const call: SessionMessage = {
    id: 10,
    display_order: 10,
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{}' } }]
  }

  const result: SessionMessage = { id: 11, display_order: 11, role: 'tool', tool_call_id: 'call', content: 'output' }
  const prompt: SessionMessage = { id: 1, display_order: 1, role: 'user', content: 'Earlier' }

  for (const rows of [[call, result], [{ ...result, tool_call_id: undefined }]]) {
    const before = toChatMessages(rows)[0]
    const shifted = toChatMessages([prompt, ...rows.map(row => ({ ...row, id: Number(row.id) + 100 }))])[1]
    expect(shifted.id).toBe(before.id)
    expect(shifted.displayOrder).toBe(rows[0].display_order)
    expect(shifted.rowId).toBe(Number(rows[0].id) + 100)
    expect(shifted.parts.map(part => part.type === 'tool-call' && part.toolCallId)).toEqual(
      before.parts.map(part => part.type === 'tool-call' && part.toolCallId)
    )
    expect(shifted.serverRowSpan ?? 1).toBe(rows.length)
  }

  const open = toChatMessages([call, result])[0]

  const completed = toChatMessages([
    call,
    result,
    { id: 12, display_order: 12, role: 'assistant', content: 'Done.' }
  ])[0]

  expect(completed.id).toBe(open.id)
  expect(completed.displayOrder).toBe(open.displayOrder)
})

it('retains the older half of a folded tool turn when pages overlap after compaction', () => {
  const prompt: SessionMessage = { id: 101, display_order: 1, role: 'user', content: 'Inspect' }

  const commentary: SessionMessage = {
    id: 102,
    display_order: 2,
    role: 'assistant',
    content: 'Checking.',
    tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{}' } }]
  }

  const toolResult: SessionMessage = {
    id: 103,
    display_order: 3,
    role: 'tool',
    tool_call_id: 'call',
    content: 'file contents'
  }

  const final: SessionMessage = { id: 104, display_order: 4, role: 'assistant', content: 'Done.' }
  const older = toChatMessages([prompt, commentary, toolResult, final])

  for (const suffix of [[final], [toolResult, final], [commentary, toolResult, final]]) {
    const tail = toChatMessages(suffix.map(row => ({ ...row, id: Number(row.id) + 100 })))
    const originalTailParts = [...tail[0].parts]

    for (const merge of [mergeOlderTranscriptPage, graftRefreshedTailOntoBackfill]) {
      const merged = merge(tail, older)
      expect(merged.map(chatMessageText)).toEqual(older.map(chatMessageText))
      expect(merged[1].parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([
        'Checking.',
        'Done.'
      ])
      const tools = merged[1].parts.filter(part => part.type === 'tool-call')
      expect(tools).toHaveLength(1)
      expect(tools[0].toolName).toBe('read_file')
      expect(tools[0].result).toEqual(tail[0].parts.find(part => part.type === 'tool-call')?.result ?? 'file contents')
      expect(merged[1].serverRowSpan).toBe(older[1].serverRowSpan)
      expect(merged.reduce((count, message) => count + (message.serverRowSpan ?? 1), 0)).toBe(4)
      expect(merged[1].parts.at(-1)?.sourceRowId).toBe(204)
      expect(mergeOlderTranscriptPage(merged, older)).toBe(merged)
      // An anchor in the very first bubble must preserve its earlier parts too.
      expect(merge(tail, older.slice(1))[0].parts).toEqual(merged[1].parts)
      expect(tail[0].parts).toEqual(originalTailParts)
    }
  }
})

it('rewinds the exact raw row count after merging every boundary of a multi-tool fold', () => {
  const call = (id: string) => ({ id, function: { name: `tool-${id}`, arguments: '{}' } })

  const rows: SessionMessage[] = [
    { role: 'user', content: 'Inspect' },
    { role: 'assistant', content: 'Done.', tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'a result' },
    { role: 'tool', tool_call_id: 'b', content: 'b result' },
    { role: 'assistant', content: '', tool_calls: [call('c')] },
    { role: 'tool', tool_call_id: 'c', content: 'c result' },
    { role: 'assistant', content: 'Done.' }
  ].map((row, index) => ({
    ...row,
    role: row.role as SessionMessage['role'],
    id: index + 10,
    display_order: index + 10
  }))

  const older = toChatMessages(rows)

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
      const merged = merge(tail, older)
      expect(
        merged
          .flatMap(message => message.parts)
          .filter(part => part.type === 'tool-call')
          .map(part => part.toolName)
      ).toEqual(['tool-a', 'tool-b', 'tool-c'])
      expect(merged.map(chatMessageText)).toEqual(older.map(chatMessageText))
      expect(mergeOlderTranscriptPage(merged, older)).toBe(merged)
      const retention = boundRetainedTranscript([...merged, slack, anchor], anchor.id)
      expect(retention).toMatchObject({ released: true, releasedServerRows: rows.length, messages: [slack, anchor] })
    }
  }
})

it('publishes provenance-only changes without repainting structurally identical provenance', () => {
  const current = toChatMessages([
    {
      id: 1,
      display_order: 1,
      role: 'assistant',
      content: 'Checking',
      tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{}' } }]
    },
    { id: 2, display_order: 2, role: 'tool', tool_call_id: 'call', content: 'result' }
  ])

  expect(preserveEquivalentTranscript(current, structuredClone(current))).toBe(current)

  for (const change of [
    (message: ChatMessage) => {
      message.serverRows![1].rowId = 202
    },
    (message: ChatMessage) => {
      message.serverRows![1].displayOrder = 22
    },
    (message: ChatMessage) => {
      message.serverRowSpan = 3
    },
    (message: ChatMessage) => {
      message.parts[1].toolResultSource!.rowId = 202
    },
    (message: ChatMessage) => {
      message.parts[1].toolResultSource!.displayOrder = 22
    },
    (message: ChatMessage) => {
      message.parts[1].sourceRowId = 201
    }
  ]) {
    const next = structuredClone(current)
    change(next[0])
    expect(preserveEquivalentTranscript(current, next)).toBe(next)
  }
})

it('preserves folded-page joins and exact spans after an actual journal reload', () => {
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
        content: 'Checking.',
        tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{}' } }]
      },
      { id: 3, display_order: 3, role: 'tool', tool_call_id: 'call', content: 'contents' },
      { id: 4, display_order: 4, role: 'assistant', content: 'Done.' }
    ]

    const older = toChatMessages(rows)
    const storedSessionId = 'folded-provenance'
    persistInFlightTurnState({
      storedSessionId,
      messages: older,
      streamId: older[1].id,
      busy: true,
      awaitingResponse: false,
      turnStartedAt: 1000
    })
    vi.advanceTimersByTime(400)
    resetInFlightTurnJournalStateForTests()

    const restored = recoverInFlightTurnJournal(storedSessionId, older.slice(0, 1))
    expect(restored.applied).toBe(true)

    const partialBase = toChatMessages(rows.slice(0, 3).map(row => ({ ...row, id: Number(row.id) + 100 })))
    const partialRecovery = recoverInFlightTurnJournal(storedSessionId, partialBase, { keepPending: true })
    expect(partialRecovery.messages.map(chatMessageText)).toEqual(['Inspect', 'Checking.', 'Done.'])
    expect(partialRecovery.messages.at(-1)).toMatchObject({
      rowId: 4,
      displayOrder: 4,
      serverRows: [{ rowId: 4, displayOrder: 4 }],
      serverRowSpan: 1
    })
    expect(partialRecovery.streamId).toBe(partialRecovery.messages.at(-1)?.id)
    expect(partialRecovery.messages.reduce((sum, message) => sum + (message.serverRowSpan ?? 1), 0)).toBe(rows.length)

    for (const start of [2, 3]) {
      const tail = toChatMessages(rows.slice(start).map(row => ({ ...row, id: Number(row.id) + 100 })))
      const merged = graftRefreshedTailOntoBackfill(tail, restored.messages)
      expect(merged.map(chatMessageText)).toEqual(older.map(chatMessageText))
      expect(merged[1].parts.filter(part => part.type === 'tool-call')).toHaveLength(1)
      expect(merged[1].serverRowSpan).toBe(rows.length - 1)
      expect(mergeOlderTranscriptPage(merged, older)).toBe(merged)
    }

    const snapshot = readInFlightTurnJournal(storedSessionId)
    expect(snapshot?.messages[1].serverRows).toEqual(older[1].serverRows)
    expect(snapshot?.messages[1].parts[1].toolResultSource).toEqual(older[1].parts[1].toolResultSource)

    // Oversized provenance must not be truncated into plausible but wrong row counts.
    const oversizedRows = Array.from({ length: 10_000 }, (_, index) => ({ rowId: index }))
    persistInFlightTurnState({
      storedSessionId,
      messages: [older[0], { ...older[1], serverRows: oversizedRows, serverRowSpan: oversizedRows.length }],
      streamId: older[1].id,
      busy: true,
      awaitingResponse: false,
      turnStartedAt: 1000
    })
    vi.advanceTimersByTime(400)
    expect(readInFlightTurnJournal(storedSessionId)).toEqual(snapshot)

    const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).find(key =>
      key?.endsWith(`:${storedSessionId}`)
    )!

    const raw = localStorage.getItem(key)!
    expect(raw).not.toBeNull()

    for (const corrupt of [
      (message: Record<string, unknown>) => {
        message.serverRows = null
      },
      (message: Record<string, unknown>) => {
        message.serverRows = [{ rowId: 'wrong' }]
      },
      (message: Record<string, unknown>) => {
        message.serverRows = [{}]
      },
      (message: Record<string, unknown>) => {
        message.serverRowSpan = 0
      },
      (message: Record<string, unknown>) => {
        ;(message.parts as Record<string, unknown>[])[1].toolResultSource = []
      }
    ]) {
      const invalid = JSON.parse(raw)
      corrupt(invalid.messages[1])
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
