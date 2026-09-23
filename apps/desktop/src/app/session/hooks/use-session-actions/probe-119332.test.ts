// Regression probe for #119326 / #119332 / #119215; keep with the identity contract.
import { describe, expect, it } from 'vitest'

import { type ChatMessage, preserveLocalAssistantErrors, textPart, toChatMessages } from '@/lib/chat-messages'
import type { SessionMessage } from '@/types/hermes'

import { reconcileDurableHistory } from './utils'

const local = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  parts: text ? [textPart(text)] : [],
  ...extra
})


describe('probe 119332 on HEAD', () => {
  it('A: older errored turn (no rowId) + newer completed turn, stable hydrated ids', () => {
    const rows: SessionMessage[] = [
      { id: 10, role: 'user', content: 'first prompt', timestamp: 100 },
      { id: 20, role: 'user', content: 'second prompt', timestamp: 200 },
      { id: 21, role: 'assistant', content: 'second reply', timestamp: 201 }
    ]
    const hydratedBefore = toChatMessages(rows.slice(0, 1))
    // Local view after the first hydration: hydrated user + the client-side error the DB cannot know about.
    const previous: ChatMessage[] = [
      hydratedBefore[0],
      local('assistant-stream-s1', 'assistant', '', { error: 'provider failed', pending: false, durableComplete: false }),
      local('user-2', 'user', 'second prompt', { rowId: 20 }),
      local('assistant-stream-s2', 'assistant', 'second reply', {
        rowId: 21,
        pending: false,
        durableComplete: true,
        persistedTurn: { complete: true, user_row_id: 20, final_assistant_row_id: 21, row_ids: [20, 21] }
      })
    ]
    const merged = reconcileDurableHistory(toChatMessages(rows), previous)

    // Expectation (desired): error stays under its own turn; newest reply at the bottom.
    expect(merged.at(-1)?.rowId).toBe(21)
  })

  it('B: same as A but hydrated ids shift (different window index)', () => {
    const rows: SessionMessage[] = [
      { id: 10, role: 'user', content: 'first prompt', timestamp: 100 },
      { id: 20, role: 'user', content: 'second prompt', timestamp: 200 },
      { id: 21, role: 'assistant', content: 'second reply', timestamp: 201 }
    ]
    // previously hydrated from a window that had one extra leading row (index shift)
    const hydratedBefore = toChatMessages([{ id: 5, role: 'assistant', content: 'older', timestamp: 50 }, rows[0]]).slice(1)
    const previous: ChatMessage[] = [
      hydratedBefore[0],
      local('assistant-stream-s1', 'assistant', '', { error: 'provider failed', pending: false, durableComplete: false }),
      local('user-2', 'user', 'second prompt', { rowId: 20 }),
      local('assistant-stream-s2', 'assistant', 'second reply', {
        rowId: 21,
        pending: false,
        durableComplete: true,
        persistedTurn: { complete: true, user_row_id: 20, final_assistant_row_id: 21, row_ids: [20, 21] }
      })
    ]
    const merged = reconcileDurableHistory(toChatMessages(rows), previous)

    expect(merged.filter(m => m.rowId === 10)).toHaveLength(1)
    expect(merged.at(-1)?.rowId).toBe(21)
  })

  it('C: newest turn errored, user row rewritten by backend (@image suffix), no assistant persisted', () => {
    const rows: SessionMessage[] = [
      { id: 10, role: 'user', content: 'look at this\n@image:/tmp/shot.png', timestamp: 100 }
    ]
    const previous: ChatMessage[] = [
      local('user-1', 'user', 'look at this', { rowId: 10, attachmentRefs: ['/Users/x/shot.png'] }),
      local('assistant-stream-s1', 'assistant', '', { error: 'provider failed', pending: false, durableComplete: false })
    ]
    const merged = reconcileDurableHistory(toChatMessages(rows), previous)

    expect(merged.filter(m => m.role === 'user')).toHaveLength(1)
    expect(merged.at(-1)?.error).toBe('provider failed')
  })

  it('D: newest turn errored after a tool round persisted; user row rewritten', () => {
    const rows: SessionMessage[] = [
      { id: 10, role: 'user', content: 'look at this\n@image:/tmp/shot.png', timestamp: 100 },
      {
        id: 11,
        role: 'assistant',
        content: '',
        timestamp: 101,
        tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{}' } }]
      },
      { id: 12, role: 'tool', tool_call_id: 'call-1', tool_name: 'read_file', content: 'x', timestamp: 102 }
    ]
    const hydrated = toChatMessages(rows)
    const toolParts = hydrated.find(m => m.role === 'assistant')!.parts
    const previous: ChatMessage[] = [
      local('user-1', 'user', 'look at this', { rowId: 10, attachmentRefs: ['/Users/x/shot.png'] }),
      local('assistant-stream-s1', 'assistant', '', {
        parts: toolParts,
        error: 'provider failed',
        pending: false,
        durableComplete: false
      })
    ]
    const merged = reconcileDurableHistory(hydrated, previous)

    expect(merged.filter(m => m.role === 'user')).toHaveLength(1)
    expect(merged.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(merged.at(-1)?.error).toBe('provider failed')
  })

  it('E (shark6s #70108): pass-1 text match then pass-2 append with different rowId', () => {
    const stored = [local('5-1-assistant', 'assistant', 'F', { rowId: 7 })]
    const userRow = local('u', 'user', 'q')
    const failed = local('assistant-stream-s', 'assistant', 'F', { rowId: 9, error: 'stream lost' })
    const merged = preserveLocalAssistantErrors(stored, [userRow, failed])

    expect(merged).toHaveLength(1)
  })

  it('F: PR 119332 test 1 shape but the errored assistant has NO rowId (what HEAD actually produces on error)', () => {
    const hydrated = [
      local('hydrated-user', 'user', 'rewritten @image:durable.png', { rowId: 10 }),
      local('hydrated-older-user', 'user', 'newest', { rowId: 30 }),
      local('hydrated-older-assistant', 'assistant', 'newest reply', { rowId: 31 })
    ]
    const previous = [
      local('local-user', 'user', 'original prompt', { rowId: 10, attachmentRefs: ['local.png'] }),
      local('local-assistant', 'assistant', '', { error: 'stream failed' }),
      local('hydrated-older-user', 'user', 'newest', { rowId: 30 }),
      local('hydrated-older-assistant', 'assistant', 'newest reply', { rowId: 31 })
    ]
    const merged = preserveLocalAssistantErrors(hydrated, previous)

    expect(merged.at(-1)?.rowId).toBe(31)
  })
})
