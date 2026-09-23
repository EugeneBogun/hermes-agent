import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createGatewayEventDedupe } from '@/app/gateway/gateway-event-dedupe'
import { chatMessageText, textPart, toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { renderMessageStream } from './test-harness'

const SID = 'recovery-stream-probe'
afterEach(cleanup)
function mount() {
  const stream = renderMessageStream(SID)
  const gate = createGatewayEventDedupe()
  const send = async (type: string, payload: Record<string, unknown>, seq: number, now = 1000, extra = {}) => {
    const event = { type, payload, session_id: SID, seq, replayEpoch: 'epoch-probe', ...extra } as GatewayEvent
    const admitted = gate.admit(event, now)
    if (admitted) await act(() => stream.handleEvent(event))
    return admitted
  }
  const texts = () => stream.state().messages.filter(m => m.role === 'assistant').map(chatMessageText)
  return { stream, send, texts }
}
it('cross-socket duplicate interim is blocked, distinct same-text occurrence preserved', async () => {
  const { send, texts } = mount()
  await send('message.start', {}, 1)
  await send('message.interim', {text: 'Checking.', already_streamed: true}, 2)
  expect(await send('message.interim', {text: 'Checking.', already_streamed: true}, 2, 1005, {connectionId: 'local'})).toBe(false)
  expect(texts()).toEqual(['Checking.'])
  await send('message.interim', {text: 'Checking.', already_streamed: true}, 3)
  expect(texts()).toEqual(['Checking.', 'Checking.'])
})
it('a delayed replay of a previously delivered interim does not duplicate it', async () => {
  const { send, texts } = mount()
  await send('message.start', {}, 1)
  await send('message.interim', {text: 'Checking.'}, 2)
  await send('message.interim', {text: 'Checking.'}, 2, 32000, {replayed: true})
  expect(texts()).toEqual(['Checking.'])
})
it('a cold replay completion matching a hydrated durable row does not append an old answer', async () => {
  const {stream, send, texts} = mount()
  stream.states.set(SID, createClientSessionState('stored-probe', toChatMessages([
    {role: 'user', row_id: 1, content: 'First question', timestamp: 1},
    {role: 'assistant', row_id: 2, content: 'First answer', timestamp: 2},
    {role: 'user', row_id: 3, content: 'Second question', timestamp: 3},
    {role: 'assistant', row_id: 4, content: 'Second answer', timestamp: 4}
  ])))
  await send('message.complete', {text: 'First answer', persisted_turn: {row_ids: [1, 2], user_row_id: 1, final_assistant_row_id: 2, complete: true}}, 2, 32000, {replayed: true})
  expect(texts()).toEqual(['First answer', 'Second answer'])
})
it('a previously unseen replayed turn is recovered even while renderer starts idle', async () => {
  const {stream, send, texts} = mount()
  expect(stream.state().busy).toBe(false)
  await send('message.start', {}, 1, 1000, {replayed: true})
  await send('message.complete', {text: 'Missed answer'}, 2, 1001, {replayed: true})
  expect(texts()).toEqual(['Missed answer'])
})
it('a new start after missing terminal event does not rewrite the abandoned bubble', async () => {
  const {stream, send, texts} = mount()
  await send('message.start', {}, 1)
  await send('message.delta', {text: 'Abandoned output'}, 2)
  await send('message.start', {}, 3)
  const oldId = stream.state().messages[0].id
  await send('message.delta', {text: 'New output'}, 4)
  await send('message.complete', {text: 'New output'}, 5)
  expect(texts()).toEqual(['Abandoned output', 'New output'])
  expect(stream.state().messages[0].id).toBe(oldId)
})
it('near-identical interim and final remain distinct without source identity', async () => {
  const {send,texts} = mount()
  const pre = 'A repeated report on the current status. '.repeat(8) + 'Status: B.'
  const final = pre.replace('Status: B.', 'Status: A.')
  await send('message.start', {}, 1)
  await send('message.interim', {text: pre}, 2)
  await send('message.complete', {text: final}, 3)
  expect(texts()).toEqual([pre, final])
})
it('Codex public commentary remains public after hydration and is not Thinking', () => {
  const preamble = 'I will inspect the requested file.'
  const messages = toChatMessages([{
    role: 'assistant', row_id: 20, content: '', finish_reason: 'tool_calls',
    reasoning: 'Inspecting file\n' + preamble,
    reasoning_content: 'Inspecting file\n' + preamble,
    codex_message_items: [{type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{type: 'output_text', text: preamble}]}],
    tool_calls: [{id: 'call', type: 'function', function: {name: 'read_file', arguments: '{}'}}]
  }] as never)
  expect(chatMessageText(messages[0])).toBe(preamble)
  expect(messages[0].parts.filter(p => p.type === 'reasoning').map(p => p.text).join('')).not.toContain(preamble)
})
it('reasoning.available is ignored when public text already streamed (control)', async () => {
  const {stream, send} = mount()
  await send('message.start', {}, 1)
  await send('reasoning.delta', {text: 'Actual private reasoning'}, 2)
  await send('message.delta', {text: 'Public answer'}, 3)
  await send('reasoning.available', {text: 'Public answer'}, 4)
  await send('message.complete', {text: 'Public answer'}, 5)
  expect(stream.state().messages.flatMap(m => m.parts).filter(p => p.type === 'reasoning').map(p => p.text)).toEqual(['Actual private reasoning'])
})
it('an answer preview before answer deltas must not replace genuine reasoning', async () => {
  const {stream, send} = mount()
  await send('message.start', {}, 1)
  await send('reasoning.delta', {text: 'Actual private reasoning'}, 2)
  await send('reasoning.available', {text: 'Public answer'}, 3)
  await send('message.complete', {text: 'Public answer'}, 4)
  expect(stream.state().messages.flatMap(m => m.parts).filter(p => p.type === 'reasoning').map(p => p.text)).toEqual(['Actual private reasoning'])
})
