import { JsonRpcGatewayClient, type GatewayEvent } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createGatewayEventDedupe } from '@/app/gateway/gateway-event-dedupe'
import { chatMessageText } from '@/lib/chat-messages'
import { renderMessageStream } from './test-harness'

class FakeSocket extends EventTarget {
  readyState = 0
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close')) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  frame(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
  event(event: unknown) { this.frame({jsonrpc: '2.0', method: 'event', params: event}) }
}
afterEach(cleanup)
it('two real clients sharing a gate must not replay old interim after cross-socket gap exceeds window', async () => {
  const sid = 'transport-probe'
  const stream = renderMessageStream(sid)
  const gate = createGatewayEventDedupe()
  let now = 1000
  const delivered: GatewayEvent[] = []
  const clients: JsonRpcGatewayClient[] = []
  function makeClient() {
    const sockets: FakeSocket[] = []
    const client = new JsonRpcGatewayClient({
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket },
      heartbeatIntervalMs: 0, heartbeatDeadlineMs: 0, connectTimeoutMs: 1000
    })
    client.onEvent(event => { if (gate.admit(event, now)) { delivered.push(event); stream.handleEvent(event) } })
    clients.push(client)
    return {client, sockets}
  }
  const a = makeClient(), b = makeClient()
  const open = async (item: ReturnType<typeof makeClient>) => {
    const connected = item.client.connect('ws://probe')
    const socket = item.sockets.at(-1)!
    socket.open()
    socket.event({type: 'gateway.ready', payload: {replay_epoch: 'epoch-transport'}})
    await connected
    return socket
  }
  try {
    let aSocket!: FakeSocket, bSocket!: FakeSocket
    await act(async () => { aSocket = await open(a); bSocket = await open(b) })
    const start = {type: 'message.start', session_id: sid, seq: 1, payload: {}}
    const interim = {type: 'message.interim', session_id: sid, seq: 2, payload: {text: 'Already painted'}}
    await act(() => { aSocket.event(start); bSocket.event(start) })
    b.client.invalidate('disconnected secondary')
    await act(() => aSocket.event(interim))
    now = 32000
    await act(async () => { bSocket = await open(b) })
    const replay = bSocket.sent.map(x => JSON.parse(x)).find(x => x.method === 'session.events.since')
    expect(replay.params.last_seen).toBe(1)
    await act(async () => {
      bSocket.frame({jsonrpc: '2.0', id: replay.id, result: {events: [interim], epoch: 'epoch-transport', latest_seq: 2, count: 1, truncated: false}})
      await Promise.resolve()
    })
    expect(delivered.filter(e => e.type === 'message.interim')).toHaveLength(1)
    expect(stream.state().messages.map(chatMessageText)).toEqual(['Already painted'])
  } finally {
    for (const client of clients) client.close()
  }
})
