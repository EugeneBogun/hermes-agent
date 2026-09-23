import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { boundRetainedTranscript, TRANSCRIPT_RETAIN_BUDGET } from '@/app/chat/transcript-retention'
import { renderMessageStream } from '@/app/session/hooks/use-message-stream/test-harness'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { mergeInFlightMessages } from '@/lib/inflight-turn-journal'
import { $approvalRequests, clearAllPrompts, setApprovalRequest } from '@/store/prompts'

vi.mock('@/lib/completion-sound', () => ({ playCompletionSound: vi.fn() }))
const sid = 'independent-review-synthetic'
afterEach(() => {
  cleanup()
  clearAllPrompts(sid)
  vi.clearAllMocks()
})

it('retains the uncovered final part of a journaled folded bubble', () => {
  const rows = [
    { id: 1, display_order: 1, role: 'user' as const, content: 'Inspect' },
    {
      id: 2,
      display_order: 2,
      role: 'assistant' as const,
      content: 'Checking.',
      tool_calls: [{ id: 'call-a', function: { name: 'read_file', arguments: '{}' } }]
    },
    { id: 3, display_order: 3, role: 'tool' as const, tool_call_id: 'call-a', content: 'contents' },
    { id: 4, display_order: 4, role: 'assistant' as const, content: 'Only journal has this final.' }
  ]

  const base = toChatMessages(rows.slice(0, 3))
  const journal = toChatMessages(rows)
  const recovered = mergeInFlightMessages(base, journal)

  expect(recovered.messages.map(chatMessageText).join('\n')).toContain('Only journal has this final.')
  expect(recovered.messages.at(-1)).toMatchObject({
    id: 'stored-4-assistant',
    rowId: 4,
    displayOrder: 4,
    serverRows: [{ rowId: 4, displayOrder: 4 }],
    serverRowSpan: 1
  })
  const running = mergeInFlightMessages(base, journal, { keepPending: true })
  expect(running.streamId).toBe('stored-4-assistant')
  expect(running.messages.find(m => m.id === running.streamId)?.parts).toEqual(recovered.messages.at(-1)?.parts)
})

it('retention never releases the unaddressed journal suffix created by prefix subtraction', () => {
  const base = toChatMessages([
    { id: 1, display_order: 1, role: 'user', content: 'Inspect' },
    {
      id: 2,
      display_order: 2,
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{}' } }]
    }
  ])

  const journal = [
    base[0],
    { ...base[1], parts: [...base[1].parts, { type: 'text' as const, text: 'Not on the backend' }] }
  ]

  const recovered = mergeInFlightMessages(base, journal)
  const suffix = recovered.messages.at(-1)!
  expect(suffix.rowId).toBeUndefined()
  expect(suffix.pending).toBe(false)

  const slack = {
    id: 'slack',
    role: 'user' as const,
    rowId: 20,
    parts: Array.from({ length: TRANSCRIPT_RETAIN_BUDGET }, () => ({ type: 'text' as const, text: '.' }))
  }

  const anchor = { id: 'anchor', role: 'user' as const, rowId: 21, parts: [{ type: 'text' as const, text: 'Later' }] }
  const retained = boundRetainedTranscript([...recovered.messages, slack, anchor], anchor.id)

  expect(retained.released && !retained.messages.includes(suffix)).toBe(false)
})

it('does not retire newer work for a historical final with incomplete turn coverage', async () => {
  const h = renderMessageStream(sid)

  const messages = toChatMessages([
    { id: 101, display_order: 1, role: 'user', content: 'Old prompt' },
    { id: 102, display_order: 2, role: 'assistant', content: 'Old answer' },
    { id: 103, display_order: 3, role: 'user', content: 'New prompt' }
  ])

  const active = {
    id: 'assistant-stream-new',
    role: 'assistant' as const,
    pending: true,
    parts: [{ type: 'text' as const, text: 'New partial' }]
  }

  const state = {
    ...createClientSessionState('stored', [...messages, active]),
    busy: true,
    awaitingResponse: true,
    needsInput: true,
    streamId: active.id
  }

  h.states.set(sid, state)
  const prompt = { sessionId: sid, requestId: 'new-approval', command: 'new command', description: 'Current turn' }
  setApprovalRequest(prompt)
  await act(() =>
    h.handleEvent({
      type: 'message.complete',
      session_id: sid,
      replayed: true,
      payload: {
        text: 'Old answer',
        persisted_turn: {
          row_ids: [1, 2],
          user_row_id: 1,
          user_display_order: 1,
          final_assistant_row_id: 2,
          final_assistant_display_order: 2,
          complete: false
        }
      }
    })
  )

  expect.soft(h.state().busy).toBe(true)
  expect.soft(h.state().streamId).toBe(active.id)
  expect.soft($approvalRequests.get()[sid]).toBe(prompt)
})

it('keeps distinct acknowledged same-text completions when the new prompt is not hydrated yet', async () => {
  const h = renderMessageStream(sid)

  const old = toChatMessages([
    { id: 1, display_order: 1, role: 'user', content: 'First prompt' },
    { id: 2, display_order: 2, role: 'assistant', content: 'Same answer' }
  ])

  h.states.set(sid, createClientSessionState('stored', old))
  await act(() => h.handleEvent({ type: 'message.start', session_id: sid, payload: {} }))
  await act(() =>
    h.handleEvent({
      type: 'message.complete',
      session_id: sid,
      payload: {
        text: 'Same answer',
        persisted_turn: {
          row_ids: [3, 4],
          user_row_id: 3,
          user_display_order: 3,
          final_assistant_row_id: 4,
          final_assistant_display_order: 4,
          complete: true
        }
      }
    })
  )

  expect(
    h
      .state()
      .messages.filter(m => m.role === 'assistant')
      .map(chatMessageText)
  ).toEqual(['Same answer', 'Same answer'])
})
