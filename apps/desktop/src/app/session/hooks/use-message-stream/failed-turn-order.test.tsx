import type { GatewayEventName } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'

import { reconcileDurableHistory } from '../use-session-actions/utils'

import { renderMessageStream } from './test-harness'

afterEach(cleanup)

it('keeps an unpersisted failed reply beside its owning prompt when newer history arrives', async () => {
  const sid = 'failed-occurrence'
  const prompt = toChatMessages([{ id: 11, display_order: 11, role: 'user', content: 'Inspect' }])[0]
  const h = renderMessageStream(sid)
  h.states.set(sid, createClientSessionState('stored', [{ ...prompt, id: 'user-local' }]))
  const send = (type: GatewayEventName, payload = {}) => act(() => h.handleEvent({ type, payload, session_id: sid }))
  await send('message.start')
  await send('message.delta', { text: 'Partial work' })
  await send('message.complete', { text: 'Partial work', status: 'error', error: 'Disconnected', partial: true })
  const failed = h.state().messages.at(-1)!
  expect(failed.rowId).toBeUndefined()

  const history = toChatMessages([
    { id: 111, display_order: 11, role: 'user', content: 'Inspect\n\n--- Attached Context ---\nnotes' },
    { id: 113, display_order: 13, role: 'user', content: 'Inspect' },
    { id: 114, display_order: 14, role: 'assistant', content: 'New reply' }
  ])

  const reconciled = reconcileDurableHistory(history, h.state().messages)
  expect(reconciled.map(chatMessageText)).toEqual([chatMessageText(history[0]), 'Partial work', 'Inspect', 'New reply'])
  expect(reconciled.filter(message => message.error)).toMatchObject([{ id: failed.id, error: 'Disconnected' }])
  expect(reconcileDurableHistory(history, reconciled).map(message => message.id)).toEqual(
    reconciled.map(message => message.id)
  )
})
