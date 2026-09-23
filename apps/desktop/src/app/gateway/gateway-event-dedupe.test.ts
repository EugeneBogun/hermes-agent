import { type GatewayEvent, JsonRpcGatewayClient } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatMessageText } from '@/lib/chat-messages'

import { renderMessageStream } from '../session/hooks/use-message-stream/test-harness'

import { createGatewayEventDedupe, DUPLICATE_WINDOW_MS } from './gateway-event-dedupe'

const delta = (seq: number, extra: Record<string, unknown> = {}) =>
  ({
    payload: { text: 'Two tools' },
    replayEpoch: 'process-seq:epoch-a',
    seq,
    session_id: 'rt-1',
    type: 'message.delta',
    ...extra
  }) as never

class TestSocket extends EventTarget {
  readyState = 0
  sent: string[] = []

  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  frame(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
  event(event: unknown) {
    this.frame({ jsonrpc: '2.0', method: 'event', params: event })
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('gateway event dedupe (#120005)', () => {
  it('deduplicates delayed reconnect replay across real clients without swallowing unseen older frames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const gate = createGatewayEventDedupe()
    const stream = renderMessageStream('rt-1')
    const delivered: GatewayEvent[] = []
    const clients: JsonRpcGatewayClient[] = []

    const makeClient = () => {
      const sockets: TestSocket[] = []

      const client = new JsonRpcGatewayClient({
        socketFactory: () => {
          const socket = new TestSocket()
          sockets.push(socket)

          return socket as unknown as WebSocket
        },
        heartbeatIntervalMs: 0,
        heartbeatDeadlineMs: 0
      })

      client.onEvent(event => {
        if (gate.admit(event) && event.session_id) {
          delivered.push(event)
          act(() => stream.handleEvent(event))
        }
      })
      clients.push(client)

      return {
        client,
        async open(epoch = 'process-seq:epoch-a') {
          const connected = client.connect('ws://test')
          const socket = sockets.at(-1)!
          socket.open()
          socket.event({ type: 'gateway.ready', payload: { replay_epoch: epoch } })
          await connected

          return socket
        }
      }
    }

    const a = makeClient()
    const b = makeClient()

    try {
      const live = await a.open()
      const secondary = await b.open()

      // The socket, not the server fixture, adopts and attaches replayEpoch.
      const frame = (seq: number) => ({
        type: seq === 1 ? 'message.start' : 'message.interim',
        session_id: 'rt-1',
        seq,
        payload: seq === 1 ? {} : { text: 'Checking.' }
      })

      live.event(frame(1))
      secondary.event(frame(1))
      b.client.invalidate('secondary disconnected')
      live.event(frame(2))
      // Socket A misses seq 3; a cross-socket high-water mark would lose it.
      live.event(frame(4))
      vi.setSystemTime(32_000)
      const reconnected = await b.open()

      const replay = reconnected.sent
        .map(text => JSON.parse(text))
        .find(request => request.method === 'session.events.since')

      expect(replay.params).toEqual({ session_id: 'rt-1', last_seen: 1 })
      reconnected.frame({
        jsonrpc: '2.0',
        id: replay.id,
        result: { events: [frame(2), frame(3), frame(4)], epoch: 'process-seq:epoch-a', truncated: false }
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(delivered.map(event => event.seq)).toEqual([1, 2, 4, 3])
      expect(stream.state().messages.map(chatMessageText)).toEqual(['Checking.', 'Checking.', 'Checking.'])
      expect(delivered.at(-1)).toMatchObject({ seq: 3, replayed: true, replayEpoch: 'process-seq:epoch-a' })
      expect(a.client.getSeqWatermarks()).toEqual({ 'rt-1': 4 })
      expect(b.client.getSeqWatermarks()).toEqual({ 'rt-1': 4 })
      // Same text in a new event remains meaningful, including after ring eviction.
      live.event(frame(100))
      secondary.event(frame(100)) // stale socket must have no effect
      expect(delivered.map(event => event.seq)).toEqual([1, 2, 4, 3, 100])
      expect(stream.state().messages.map(chatMessageText)).toEqual(['Checking.', 'Checking.', 'Checking.', 'Checking.'])
      a.client.invalidate('backend restarted')
      const restarted = await a.open('process-seq:epoch-b')
      restarted.event(frame(1))

      const restartReplay = restarted.sent
        .map(text => JSON.parse(text))
        .find(request => request.method === 'session.events.since')

      restarted.frame({ jsonrpc: '2.0', id: restartReplay.id, result: { events: [], epoch: 'process-seq:epoch-b' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(delivered.at(-1)).toMatchObject({ seq: 1, replayEpoch: 'process-seq:epoch-b' })
    } finally {
      for (const client of clients) {
        client.close()
      }
    }
  })

  it('admits a frame once even when a second socket to the same backend delivers it again', () => {
    // The backend stamps `seq` before its transport fan-out, so both sockets
    // carry the same (epoch, session, seq); the second copy must not reach
    // the stores or the streaming text doubles.
    const gate = createGatewayEventDedupe()

    expect(gate.admit(delta(359), 1_000)).toBe(true)
    expect(gate.admit(delta(359, { connectionId: 'local' }), 1_005)).toBe(false)
    expect(gate.admit(delta(360), 1_010)).toBe(true)

    // A different backend process has a different epoch: never a duplicate.
    expect(gate.admit(delta(359, { replayEpoch: 'process-seq:epoch-b' }), 1_020)).toBe(true)
    expect(gate.admit(delta(359, { session_id: 'rt-2' }), 1_020)).toBe(true)
    // Renderer route tags are not identity once the backend supplies its epoch.
    expect(gate.admit(delta(359, { connectionId: 'other-route', profile: 'work' }), 1_020)).toBe(false)
    const legacy = { replayEpoch: undefined, connectionId: 'remote', profile: 'work' }
    expect(gate.admit(delta(359, legacy), 1_020)).toBe(true)
    expect(gate.admit(delta(359, { ...legacy, profile: 'personal' }), 1_020)).toBe(true)
    expect(gate.admit(delta(359, { ...legacy, connectionId: 'local' }), 1_020)).toBe(true)
    expect(gate.admit(delta(359, legacy), 1_020)).toBe(false)
  })

  it('bounds remembered frames and LRU sessions without expiring retained identities', () => {
    const gate = createGatewayEventDedupe()

    for (let seq = 1; seq <= 2_049; seq += 1) {
      expect(gate.admit(delta(seq), 1_000)).toBe(true)
    }

    // Explicit memory budget: 2048 admitted identities per session, not a TTL.
    expect(gate.admit(delta(2), 1_000_000)).toBe(false)
    expect(gate.admit(delta(2_049), 1_000_000)).toBe(false)
    expect(gate.admit(delta(1), 1_000_000)).toBe(true)

    for (let session = 1; session <= 255; session += 1) {
      expect(gate.admit(delta(1, { session_id: `other-${session}` }), 1_000)).toBe(true)
    }

    // Touching our active session prevents the 257th session evicting it.
    expect(gate.admit(delta(2_049), 1_000_000)).toBe(false)
    expect(gate.admit(delta(1, { session_id: 'other-256' }), 1_000_000)).toBe(true)
    expect(gate.admit(delta(2_049), 1_000_000)).toBe(false)
    expect(gate.admit(delta(1, { session_id: 'other-2' }), 1_000_000)).toBe(false)
    expect(gate.admit(delta(1, { session_id: 'other-1' }), 1_000_000)).toBe(true)
  })

  it('retains process-sequenced identities but expires legacy fallbacks and passes seq-less events', () => {
    const gate = createGatewayEventDedupe()

    for (let seq = 1; seq <= 5; seq += 1) {
      expect(gate.admit(delta(seq), 1_000 + seq)).toBe(true)
    }

    expect(gate.admit(delta(1), 1_010 + DUPLICATE_WINDOW_MS)).toBe(false)
    expect(gate.admit(delta(1, { replayEpoch: undefined }), 1_000)).toBe(true)
    expect(gate.admit(delta(1, { replayEpoch: undefined }), 1_010)).toBe(false)
    expect(gate.admit(delta(1, { replayEpoch: undefined }), 1_010 + DUPLICATE_WINDOW_MS)).toBe(true)
    // Older backends have an epoch but still reuse seq after ring eviction.
    const legacyEpoch = { replayEpoch: 'old-backend-uuid' }
    expect(gate.admit(delta(1, legacyEpoch), 1_000)).toBe(true)
    expect(gate.admit(delta(1, legacyEpoch), 1_010)).toBe(false)
    expect(gate.admit(delta(1, legacyEpoch), 1_010 + DUPLICATE_WINDOW_MS)).toBe(true)

    expect(gate.admit(delta(2, { seq: undefined }), 1_000)).toBe(true)
    expect(gate.admit(delta(2, { seq: undefined }), 1_000)).toBe(true)
    expect(gate.admit({ payload: {}, type: 'skin.changed' } as never, 1_000)).toBe(true)
    expect(gate.admit({ payload: {}, type: 'skin.changed' } as never, 1_000)).toBe(true)
  })
})
