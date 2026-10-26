'use client';

import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useEffect, useRef, useState } from 'react';
import { mintEventsAssertion } from '@/app/agent/actions';
import { type ConsoleEvent, parseEvent } from './console-view';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export interface TwoKeyEventsOptions {
  /** The gateway's public origin; the stream is GET {gatewayUrl}/human/events. */
  gatewayUrl: string;
  /** Runs each time a stream opens; `again` is true after a drop, so callers can catch up. */
  onOpen?: (again: boolean) => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

class StreamClosed extends Error {}

/** 1 s, 2 s, 4 s … capped at 30 s, with up to 25% jitter so tabs don't reconnect in step. */
export function backoffMs(attempt: number): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(base * (1 + Math.random() * 0.25));
}

/**
 * Subscribes to the gateway's event stream for the signed-in user. Each (re)connect mints a
 * fresh single-use events:read assertion through a server action; errors back off
 * exponentially. Returns the connection status for the "Live" indicator.
 */
export function useTwoKeyEvents(
  onEvent: (e: ConsoleEvent) => void,
  { gatewayUrl, onOpen }: TwoKeyEventsOptions,
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  // Latest callbacks without restarting the stream on every render.
  const handlers = useRef({ onEvent, onOpen });
  handlers.current = { onEvent, onOpen };

  useEffect(() => {
    const ctrl = new AbortController();
    const url = new URL('/human/events', gatewayUrl).toString();
    let opened = 0;

    async function loop() {
      let attempt = 0;
      while (!ctrl.signal.aborted) {
        try {
          const token = await mintEventsAssertion();
          // fetchEventSource only listens for a future abort; an earlier one would leak a stream.
          if (ctrl.signal.aborted) return;
          await fetchEventSource(url, {
            signal: ctrl.signal,
            headers: { authorization: `Bearer ${token}` },
            // The assertion is single-use; the library's own hide/show reconnect would reuse it.
            openWhenHidden: true,
            async onopen(res) {
              const type = res.headers.get('content-type') ?? '';
              if (!res.ok || !type.includes('text/event-stream')) {
                throw new Error(`events stream refused (${res.status})`);
              }
              attempt = 0;
              setStatus('live');
              handlers.current.onOpen?.(opened++ > 0);
            },
            onmessage(msg) {
              const event = parseEvent(msg.event, msg.data);
              if (event) handlers.current.onEvent(event);
            },
            onclose() {
              throw new StreamClosed('events stream closed');
            },
            onerror(err) {
              // Rethrow: retries happen in this loop, each with a new assertion.
              throw err;
            },
          });
          if (ctrl.signal.aborted) return;
        } catch {
          if (ctrl.signal.aborted) return;
        }
        // A stream also counts as a drop when the server closed it cleanly.
        setStatus('reconnecting');
        const delay = backoffMs(attempt++);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    }

    void loop();
    return () => ctrl.abort();
  }, [gatewayUrl]);

  return status;
}
