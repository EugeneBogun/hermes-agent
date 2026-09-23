import { expect, it } from 'vitest'

import { type ChatMessage, chatMessageText, textPart } from '@/lib/chat-messages'

import { reconcileResumeMessages } from './utils'

it('keeps resume metadata with its logical occurrence when the history window shifts', () => {
  const user = (displayOrder: number, local = false): ChatMessage => ({
    id: `${local ? 'local' : 'stored'}-user-${displayOrder}`,
    role: 'user',
    rowId: local ? displayOrder : displayOrder + 1000,
    displayOrder,
    parts: [textPart('Repeat the check.')],
    ...(local ? { attachmentRefs: [`@file:/checks/${displayOrder}.txt`] } : {})
  })

  const assistant = (displayOrder: number, local = false): ChatMessage => ({
    id: `${local ? 'assistant-stream' : 'stored-assistant'}-${displayOrder}`,
    role: 'assistant',
    rowId: local ? displayOrder : displayOrder + 1000,
    displayOrder,
    pending: local,
    parts: local
      ? [{ type: 'reasoning', text: `Checking occurrence ${displayOrder}.` }, textPart('Done.')]
      : [textPart('Done.')],
    ...(local ? { reactions: [{ emoji: '✅', author: 'user' as const, at: displayOrder }] } : {})
  })

  const previous = [user(10, true), assistant(11, true), user(20, true), assistant(21, true)]

  // Expanding a stored bubble can prepend earlier parts, so its authoritative
  // text need not be a prefix extension of the cached live answer. Its final
  // source occurrence survives both folding and a changed physical row id.
  const expanded: ChatMessage = {
    ...assistant(18),
    parts: [
      { ...textPart('Earlier persisted context.'), sourceRowId: 1018, sourceDisplayOrder: 18 },
      { ...textPart('Done. Stored details.'), sourceRowId: 1021, sourceDisplayOrder: 21 }
    ]
  }

  for (const next of [
    [user(20), expanded, user(30), assistant(31)],
    [user(5), assistant(6), user(10), assistant(11), user(20), expanded]
  ]) {
    const result = reconcileResumeMessages(next, previous)

    // Equal prose is repeated history, not duplicate data to collapse.
    expect(result.map(message => message.id)).toEqual(next.map(message => message.id))

    for (const [index, stored] of next.entries()) {
      const occurrence = stored === expanded ? 21 : stored.displayOrder
      const local = previous.find(message => message.role === stored.role && message.displayOrder === occurrence)
      expect.soft(result[index].attachmentRefs).toEqual(local?.attachmentRefs)
      expect.soft(result[index].reactions).toEqual(local?.reactions)
      expect.soft(result[index].pending).toBe(stored.pending)
      expect.soft(result[index].rowId).toBe(stored.rowId)
      expect.soft(chatMessageText(result[index])).toBe(chatMessageText(stored))
      expect
        .soft(result[index].parts.filter(part => part.type === 'reasoning'))
        .toEqual(local?.parts.filter(part => part.type === 'reasoning') ?? [])
    }
  }
})
