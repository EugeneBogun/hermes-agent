import type { GatewayEvent, GatewayEventName } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { playCompletionSound } from '@/lib/completion-sound'
import { mergeInFlightMessages } from '@/lib/inflight-turn-journal'
import { $approvalRequests, clearAllPrompts, setApprovalRequest } from '@/store/prompts'

import { renderMessageStream } from './test-harness'

vi.mock('@/lib/completion-sound', () => ({ playCompletionSound: vi.fn() }))
const SID = 'receipt-replay'
afterEach(() => {
  cleanup()
  clearAllPrompts(SID)
  vi.clearAllMocks()
})

it.each([true, false])(
  'uses receipt identity (complete=%s) before changing a newer turn, while recovering unseen completions',
  async complete => {
    const h = renderMessageStream(SID)

    const messages = toChatMessages([
      { id: 101, display_order: 1, role: 'user', content: 'First' },
      { id: 102, display_order: 2, role: 'assistant', content: 'First answer' },
      { id: 103, display_order: 3, role: 'user', content: 'Second' },
      { id: 104, display_order: 4, role: 'assistant', content: 'Second answer' }
    ])

    const receipt = {
      row_ids: [1, 2],
      user_row_id: 1,
      user_display_order: 1,
      final_assistant_row_id: 2,
      final_assistant_display_order: 2,
      complete
    }

    for (const busy of [false, true]) {
      const active = {
        id: 'assistant-stream-new',
        role: 'assistant' as const,
        pending: true,
        parts: [{ type: 'text' as const, text: 'New partial' }]
      }

      const state = {
        ...createClientSessionState('stored', busy ? [...messages.slice(0, 3), active] : messages),
        busy,
        awaitingResponse: busy,
        needsInput: busy,
        streamId: busy ? active.id : null
      }

      h.states.set(SID, state)

      const prompt = {
        sessionId: SID,
        requestId: 'new-approval',
        command: 'current command',
        description: 'Current turn'
      }

      setApprovalRequest(prompt)
      await act(() =>
        h.handleEvent({
          type: 'message.complete',
          session_id: SID,
          replayed: true,
          payload: { text: 'First answer', persisted_turn: receipt }
        } as GatewayEvent)
      )
      expect(h.state()).toBe(state)
      expect($approvalRequests.get()[SID]).toBe(prompt)
      expect(playCompletionSound).not.toHaveBeenCalled()
    }

    const streaming = { ...messages[1], id: 'assistant-stream-first', pending: true }
    h.states.set(SID, {
      ...createClientSessionState('stored', [messages[0], streaming, messages[2]]),
      streamId: streaming.id,
      busy: true,
      awaitingResponse: true
    })
    await act(() =>
      h.handleEvent({
        type: 'message.complete',
        session_id: SID,
        payload: { text: 'First answer', persisted_turn: receipt }
      } as GatewayEvent)
    )
    expect(h.state().messages[2]).toMatchObject({ rowId: 103, displayOrder: 3 })

    // A receipt missing from the transcript is not stale merely because the
    // renderer is idle. Its missed start/completion still has to recover.
    h.states.set(SID, createClientSessionState('stored', messages))
    await act(() =>
      h.handleEvent({ type: 'message.start', session_id: SID, payload: {}, replayed: true } as GatewayEvent)
    )
    await act(() =>
      h.handleEvent({
        type: 'message.complete',
        session_id: SID,
        replayed: true,
        payload: {
          text: 'Previously unseen answer',
          persisted_turn: { ...receipt, final_assistant_row_id: 6, final_assistant_display_order: 6 }
        }
      } as GatewayEvent)
    )
    expect(h.state().messages.map(chatMessageText)).toEqual([
      ...messages.map(chatMessageText),
      'Previously unseen answer'
    ])
    expect(h.state().busy).toBe(false)
  }
)

it.each(['unhydrated-prompt', 'historical-interim'] as const)(
  'keeps accepted-turn ownership across a replay with an %s',
  async scenario => {
    const h = renderMessageStream(SID)

    const historical = toChatMessages([
      { id: 101, display_order: 1, role: 'user', content: 'Old prompt' },
      { id: 102, display_order: 2, role: 'assistant', content: 'Same answer' }
    ])

    const receipt = {
      row_ids: [1, 2],
      user_row_id: 1,
      user_display_order: 1,
      final_assistant_row_id: 2,
      final_assistant_display_order: 2,
      complete: false
    }

    if (scenario === 'unhydrated-prompt') {
      h.states.set(SID, createClientSessionState('stored', historical))
      await act(() => h.handleEvent({ type: 'message.start', session_id: SID, payload: {} }))
    } else {
      // Adopted live work need not have replayed its start. An older interim's
      // presentation flag does not transfer ownership across the new prompt.
      const active = { id: 'current-stream', role: 'assistant' as const, pending: true, parts: [] }
      h.states.set(SID, {
        ...createClientSessionState('stored', [
          historical[0],
          { ...historical[1], interim: true },
          { id: 'new-user', role: 'user', parts: [{ type: 'text', text: 'New prompt' }] },
          active
        ]),
        busy: true,
        awaitingResponse: true,
        turnLive: true,
        streamId: active.id
      })
    }

    const prompt = { sessionId: SID, requestId: 'current-approval', command: 'current command', description: 'Current' }
    setApprovalRequest(prompt)
    const before = h.state()
    await act(() =>
      h.handleEvent({
        type: 'message.complete',
        session_id: SID,
        replayed: true,
        payload: { text: 'Same answer', persisted_turn: receipt }
      })
    )
    expect.soft(h.state()).toBe(before)
    expect.soft(h.state().busy).toBe(true)
    expect.soft(h.state().streamId).toBe(before.streamId)
    expect.soft($approvalRequests.get()[SID]).toBe(prompt)
    expect.soft(playCompletionSound).not.toHaveBeenCalled()

    // The current occurrence can have the same text and only partial durable
    // coverage. Its identity may arrive while streaming or after an interim
    // seal, with the next queued prompt already painted after it.
    await act(() => h.handleEvent({ type: 'message.delta', session_id: SID, payload: { text: 'Same answer' } }))
    await act(() =>
      h.handleEvent({
        type: scenario === 'historical-interim' ? 'message.interim' : 'tool.start',
        session_id: SID,
        payload: { text: 'Same answer', name: 'terminal', tool_id: 'current-tool' }
      })
    )
    const currentId = h.state().messages.at(-1)!.id
    const queued = { id: `user-queued-${SID}`, role: 'user' as const, parts: [{ type: 'text' as const, text: 'Next' }] }
    h.states.set(SID, {
      ...h.state(),
      messages: [
        ...h
          .state()
          .messages.map(message => (message.id === currentId ? { ...message, rowId: 104, displayOrder: 4 } : message)),
        queued
      ]
    })

    const currentReceipt = {
      ...receipt,
      row_ids: [3, 4],
      user_row_id: 3,
      user_display_order: 3,
      final_assistant_row_id: 4,
      final_assistant_display_order: 4
    }

    await act(() =>
      h.handleEvent({
        type: 'message.complete',
        session_id: SID,
        payload: { text: 'Same answer', persisted_turn: currentReceipt }
      })
    )
    expect(h.state()).toMatchObject({ busy: false, streamId: null })
    expect(h.state().messages.find(message => message.id === currentId)).toMatchObject({
      pending: false,
      interim: false,
      persistedTurn: currentReceipt,
      durableComplete: false
    })
    expect(h.state().messages.at(-1)).toBe(queued)
    expect($approvalRequests.get()[SID]).toBeUndefined()
  }
)

it.each([false, true])('retires ownership before adopting a running turn (optimistic=%s)', async optimistic => {
  const h = renderMessageStream(SID)
  const send = (type: GatewayEventName, payload: Record<string, unknown> = {}) =>
    act(() => h.handleEvent({ type, session_id: SID, payload }))

  const receipt = {
    row_ids: [1, 2],
    user_row_id: 1,
    user_display_order: 1,
    final_assistant_row_id: 2,
    final_assistant_display_order: 2,
    complete: false
  }

  h.states.set(SID, createClientSessionState('stored', toChatMessages([{ id: 1, role: 'user', content: 'First' }])))
  await send('message.start')
  await send('message.delta', { text: 'First answer' })
  await send('message.interim', { text: 'First answer' })
  await send('message.complete', { text: 'First answer', persisted_turn: receipt })
  const completed = h.state().messages.at(-1)!
  expect(h.state()).toMatchObject({ busy: false, turnLive: false })
  expect.soft(h.state().completionTurn?.currentMessageIds ?? []).toEqual([])

  // An external turn can be adopted idle or after an optimistic submit, and
  // need not replay message.start. Neither may revive the completed owner.
  h.states.set(SID, {
    ...h.state(),
    busy: optimistic,
    awaitingResponse: optimistic,
    messages: [...h.state().messages, ...toChatMessages([{ id: 3, role: 'user', content: 'Second' }])]
  })
  await send('session.info', { running: true })
  expect.soft(h.state().turnLive).toBe(true)
  await send('message.delta', { text: 'Second answer' })
  await send('tool.start', { name: 'terminal', tool_id: 'second-tool' })
  const prompt = { sessionId: SID, requestId: 'second-approval', command: 'current command', description: 'Current' }
  setApprovalRequest(prompt)
  const active = h.state()
  vi.mocked(playCompletionSound).mockClear()

  await act(() =>
    h.handleEvent({
      type: 'message.complete',
      session_id: SID,
      replayed: true,
      payload: { text: 'First answer', persisted_turn: receipt }
    } as GatewayEvent)
  )
  expect.soft(h.state()).toBe(active)
  expect.soft(h.state().busy).toBe(true)
  expect.soft(h.state().streamId).toBe(active.streamId)
  expect.soft(h.state().messages.find(message => message.id === completed.id)).toBe(completed)
  expect.soft($approvalRequests.get()[SID]).toBe(prompt)
  expect.soft(playCompletionSound).not.toHaveBeenCalled()

  // Heartbeats must retain this turn's sealed output even when a queued
  // prompt is already visible; its own partial receipt still settles it.
  await send('message.interim', { text: 'Second answer' })
  const currentId = h.state().messages.at(-1)!.id
  const queued = { id: `user-queued-${SID}`, role: 'user' as const, parts: [{ type: 'text' as const, text: 'Next' }] }
  h.states.set(SID, {
    ...h.state(),
    messages: [
      ...h
        .state()
        .messages.map(message => (message.id === currentId ? { ...message, rowId: 4, displayOrder: 4 } : message)),
      queued
    ]
  })
  await send('session.info', { running: true })
  await send('session.info', { running: true })
  const currentReceipt = {
    ...receipt,
    row_ids: [3, 4],
    user_row_id: 3,
    user_display_order: 3,
    final_assistant_row_id: 4,
    final_assistant_display_order: 4
  }
  await send('message.complete', { text: 'Second answer', persisted_turn: currentReceipt })
  expect(h.state()).toMatchObject({ busy: false, turnLive: false, streamId: null })
  expect(h.state().messages.find(message => message.id === currentId)).toMatchObject({
    pending: false,
    interim: false,
    persistedTurn: currentReceipt,
    durableComplete: false
  })
  expect(h.state().messages.at(-1)).toBe(queued)
  expect($approvalRequests.get()[SID]).toBeUndefined()
})

it.each(['error', 'running-false', 'interrupted-complete'] as const)(
  'retires ownership on %s before adopting without a hydrated prompt',
  async terminal => {
    const h = renderMessageStream(SID)
    const send = (type: GatewayEventName, payload: Record<string, unknown> = {}) =>
      act(() => h.handleEvent({ type, session_id: SID, payload }))

    await send('message.start')
    await send('message.delta', { text: 'Old partial' })
    await send('message.interim', { text: 'Old partial' })
    const oldId = h.state().messages.at(-1)!.id
    h.states.set(SID, {
      ...h.state(),
      messages: h.state().messages.map(message => ({ ...message, rowId: 2, displayOrder: 2 })),
      interrupted: terminal === 'interrupted-complete'
    })
    if (terminal === 'error') {
      await send('error', { message: 'Disconnected' })
    } else if (terminal === 'running-false') {
      await send('session.info', { running: false })
    } else {
      await send('message.complete', { text: 'Old partial' })
    }
    expect(h.state()).toMatchObject({ busy: false, turnLive: false, streamId: null })
    expect.soft(h.state().completionTurn?.currentMessageIds ?? []).toEqual([])

    // The new turn's prompt has not arrived yet. Adoption itself must fence
    // the old interim, not just a later user row or the current stream id.
    h.states.set(SID, { ...h.state(), interrupted: false })
    await send('session.info', { running: true })
    await send('session.info', { running: true })
    const before = h.state()
    await send('message.complete', {
      text: 'Old partial',
      persisted_turn: { row_ids: [2], final_assistant_row_id: 2, final_assistant_display_order: 2, complete: false }
    })
    expect(h.state()).toBe(before)
    expect(h.state().messages.find(message => message.id === oldId)?.interim).toBe(true)
  }
)

it.each(['equal', 'pending', 'stream', 'interim', 'previewed', 'sealed', 'tool-interim'] as const)(
  'does not settle an unmatched receipt onto a different known occurrence via %s',
  async path => {
    const h = renderMessageStream(SID)

    const messages = toChatMessages([
      { id: 101, display_order: 1, role: 'user', content: 'First' },
      { id: 102, display_order: 2, role: 'assistant', content: 'Same answer' }
    ])

    const prior = {
      ...messages[1],
      pending: path === 'pending' || path === 'stream',
      interim: ['interim', 'previewed', 'sealed', 'tool-interim'].includes(path)
    }

    h.states.set(SID, createClientSessionState('stored', [messages[0], prior]))
    await act(() => h.handleEvent({ type: 'message.start', session_id: SID, payload: {} }))
    const sealed = path === 'sealed'
    h.states.set(SID, {
      ...h.state(),
      streamId: path === 'stream' ? prior.id : null,
      interimBoundaryPending: sealed || path === 'previewed' || path === 'tool-interim',
      messages: sealed
        ? [...h.state().messages, { id: 'later-user', role: 'user', parts: [{ type: 'text', text: 'Next' }] }]
        : h.state().messages
    })

    if (path === 'tool-interim') {
      await act(() =>
        h.handleEvent({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: 'new-tool' } })
      )
      await act(() =>
        h.handleEvent({
          type: 'tool.complete',
          session_id: SID,
          payload: { name: 'terminal', tool_id: 'new-tool', result: 'ok' }
        })
      )
    }

    const receipt = {
      row_ids: [3, 4],
      user_row_id: 3,
      user_display_order: 3,
      final_assistant_row_id: 4,
      final_assistant_display_order: 4,
      complete: false
    }

    const text = path === 'previewed' ? 'Rewritten answer' : 'Same answer'
    await act(() =>
      h.handleEvent({
        type: 'message.complete',
        session_id: SID,
        payload: { text, response_previewed: path === 'previewed', persisted_turn: receipt }
      })
    )
    const assistants = h.state().messages.filter(message => message.role === 'assistant')
    expect(assistants.map(chatMessageText)).toEqual(['Same answer', text])
    expect(assistants[0]).toBe(prior)
    expect(assistants[1]).toMatchObject({ rowId: 4, displayOrder: 4, durableComplete: false, persistedTurn: receipt })
    expect(assistants[1].parts.findLast(part => part.type === 'text')).toMatchObject({
      sourceRowId: 4,
      sourceDisplayOrder: 4
    })
    expect(h.state().busy).toBe(false)
  }
)

it.each([false, true])('still settles legacy or unaddressed recovered output (receipt=%s)', async withReceipt => {
  const h = renderMessageStream(SID)

  const stored = toChatMessages([
    { id: 1, role: 'user', content: 'Prompt' },
    { id: 2, role: 'assistant', content: 'Answer' }
  ])

  const local = {
    id: 'assistant-stream-local',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'Answer' }]
  }

  const messages = withReceipt ? mergeInFlightMessages(stored.slice(0, 1), [stored[0], local]).messages : stored

  const receipt = withReceipt
    ? { row_ids: [1, 2], user_row_id: 1, final_assistant_row_id: 2, complete: false }
    : undefined

  h.states.set(SID, createClientSessionState('stored', messages))
  await act(() => h.handleEvent({ type: 'message.start', session_id: SID, payload: {} }))
  await act(() =>
    h.handleEvent({ type: 'message.complete', session_id: SID, payload: { text: 'Answer', persisted_turn: receipt } })
  )
  expect(h.state().messages.map(chatMessageText)).toEqual(['Prompt', 'Answer'])
  expect(h.state().messages.at(-1)).toMatchObject({
    id: messages.at(-1)!.id,
    rowId: 2,
    recovered: false,
    durableComplete: false
  })
  expect(h.state().messages.at(-1)?.persistedTurn).toEqual(receipt)
})

it('seals an abandoned stream before an accepted new start instead of rewriting it', async () => {
  const h = renderMessageStream(SID)

  const send = (type: GatewayEventName, text = '') =>
    act(() => h.handleEvent({ type, session_id: SID, payload: { text } }))

  await send('message.start')
  await send('message.delta', 'Abandoned output')
  await send('message.start')
  const abandoned = h.state().messages[0]
  await send('message.delta', 'New output')
  await send('message.complete', 'New output')
  expect(h.state().messages.map(chatMessageText)).toEqual(['Abandoned output', 'New output'])
  expect(h.state().messages[0]).toBe(abandoned)
  expect(abandoned.pending).toBe(false)
})
