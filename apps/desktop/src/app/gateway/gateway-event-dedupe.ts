import type { GatewayEvent } from '@hermes/shared'

/**
 * Cross-socket duplicate gate for backend events (#120005 / #120007).
 *
 * The backend joins EVERY socket that sends a session call to that chat's
 * transport fan-out (`tui_gateway/session_transports.py`, intended: shared
 * chats keep every attached client in sync) and stamps `seq` once per event
 * before the fan-out. When this renderer holds two sockets to ONE backend
 * (a registry secondary next to the primary during a swap, a reconnect that
 * overlaps a live socket, a relay-retained secondary) it receives the same
 * frame twice, and every `message.delta` is appended twice while the second
 * `message.interim` seals a duplicate bubble. `JsonRpcGateway` is one instance
 * per socket, so its per-socket `lastSeenSeq` cannot see the other copy; this
 * gate sits where both fan-ins meet, before any store runs.
 *
 * Key: `(replay_epoch, session_id, seq)`. Two sockets to the same process
 * share the epoch (a uuid4 minted per backend process, adopted per socket from
 * `gateway.ready`), so the key cannot collide across different backends.
 *
 * Process-sequenced identities have no time expiry: a second socket can reconnect
 * long after another socket delivered its replay. The backend's process-wide
 * counter never reuses a seq when a session's replay ring is evicted. Keep an
 * exact bounded set, not a high-water mark: an unseen older frame from a slower
 * socket still belongs in the transcript. The per-session cap exceeds the
 * backend's 512-frame replay ring; inactive sessions are evicted LRU.
 *
 * `process-seq:` epochs advertise that non-reuse contract. Older backends emit
 * plain UUID epochs but reuse seqs after ring eviction, so they keep the short
 * window rather than silently losing legitimate events after an app-only update.
 * Without any epoch, also scope the fallback to the connection and profile.
 *
 * Events without `seq` or `session_id` (session-less globals, client-local
 * events, legacy backends) always pass — there is no ordering contract to
 * enforce on them.
 */
export const DUPLICATE_WINDOW_MS = 30_000
const SEQS_PER_SESSION_MAX = 2048
const SESSIONS_MAX = 256

interface SessionSeen {
  /** seq → wall-clock time first admitted; insertion order = admission order. */
  seen: Map<number, number>
}

export interface GatewayEventDedupe {
  /** True when the event is new and must be handled; false when another socket already delivered it. */
  admit(event: GatewayEvent, now?: number): boolean
}

function sessionKey(event: GatewayEvent): string {
  // Before `gateway.ready` a socket has no epoch; bucket by connection so the
  // pair still deduplicates within one backend URL.
  return JSON.stringify(
    event.replayEpoch
      ? ['epoch', event.replayEpoch, event.session_id]
      : ['connection', event.connectionId ?? '', event.profile ?? '', event.session_id]
  )
}

export function createGatewayEventDedupe(): GatewayEventDedupe {
  const sessions = new Map<string, SessionSeen>()

  const touch = (key: string): SessionSeen => {
    let entry = sessions.get(key)

    if (entry) {
      // Re-insert so Map iteration order doubles as LRU order.
      sessions.delete(key)
    } else {
      entry = { seen: new Map() }
    }

    sessions.set(key, entry)

    while (sessions.size > SESSIONS_MAX) {
      const oldest = sessions.keys().next().value

      if (oldest === undefined) {
        break
      }

      sessions.delete(oldest)
    }

    return entry
  }

  return {
    admit(event, now = Date.now()) {
      const seq = event.seq

      if (!event.session_id || typeof seq !== 'number' || !Number.isFinite(seq)) {
        return true
      }

      const entry = touch(sessionKey(event))
      const firstSeenAt = entry.seen.get(seq)
      const nonReusingSequence = event.replayEpoch?.startsWith('process-seq:') === true

      if (firstSeenAt !== undefined && (nonReusingSequence || now - firstSeenAt < DUPLICATE_WINDOW_MS)) {
        return false
      }

      // Re-admitting a legacy event after the window refreshes the stamp;
      // deleting first keeps insertion order meaningful for the cap below.
      entry.seen.delete(seq)
      entry.seen.set(seq, now)

      while (entry.seen.size > SEQS_PER_SESSION_MAX) {
        const oldest = entry.seen.keys().next().value

        if (oldest === undefined) {
          break
        }

        entry.seen.delete(oldest)
      }

      return true
    }
  }
}
