import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createAgentRelayClient } from '../agent/src/relay.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('hosted relay client', () => {
  test('authenticates outbound and carries runtime requests', async () => {
    let resolveResponse = () => undefined;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    class FakeRelaySocket extends EventEmitter {
      readyState = 1;

      send(raw) {
        const message = JSON.parse(raw);
        if (message.type === 'hello') {
          expect(message).toMatchObject({ agentId: 'agent-1', agentSecret: 'secret-1' });
          queueMicrotask(() => {
            this.emit('message', JSON.stringify({ type: 'ready', agentId: 'agent-1' }));
            this.emit('message', JSON.stringify({
              type: 'request',
              requestId: 'request-1',
              command: { kind: 'http', request: { url: '/v1/test', method: 'GET' } }
            }));
          });
        }
        if (message.type === 'response') resolveResponse(message);
      }

      close() {
        this.readyState = 3;
        this.emit('close');
      }
    }
    const socket = new FakeRelaySocket();
    const relay = createAgentRelayClient({
      runtimeConfig: { controlPlaneUrl: 'https://app.kubi.live', agentId: 'agent-1', agentSecret: 'secret-1' },
      platform: 'linux/x64',
      version: '0.1.1',
      capabilities: { runtimeApiVersion: '2' },
      webSocketFactory: () => {
        queueMicrotask(() => socket.emit('open'));
        return socket;
      },
      async dispatch(request) {
        return { status: 200, payload: { url: request.url }, headers: {} };
      }
    });

    try {
      relay.start();
      expect(await response).toMatchObject({
        type: 'response',
        requestId: 'request-1',
        result: { status: 200, payload: { url: '/v1/test' } }
      });
    } finally {
      relay.close();
    }
  });

  test('reconnects after an open relay socket stops answering pings', async () => {
    const sockets = [];
    const relay = createAgentRelayClient({
      runtimeConfig: { controlPlaneUrl: 'https://app.kubi.live', agentId: 'agent-1', agentSecret: 'secret-1' },
      platform: 'linux/x64',
      version: '0.1.5',
      capabilities: { runtimeApiVersion: '2' },
      livenessIntervalMs: 5,
      readyTimeoutMs: 20,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      reconnectJitterMs: 0,
      webSocketFactory: () => {
        const socket = Object.assign(new EventEmitter(), {
          readyState: 1,
          terminated: false,
          send(raw) {
            if (JSON.parse(raw).type === 'hello') {
              queueMicrotask(() => socket.emit('message', JSON.stringify({ type: 'ready', agentId: 'agent-1' })));
            }
          },
          ping() {},
          terminate() {
            socket.terminated = true;
            socket.readyState = 3;
            socket.emit('close');
          },
          close() {
            socket.readyState = 3;
            socket.emit('close');
          }
        });
        sockets.push(socket);
        queueMicrotask(() => socket.emit('open'));
        return socket;
      },
      async dispatch() {
        return { status: 200, payload: {}, headers: {} };
      }
    });

    try {
      relay.start();
      await wait(35);
      expect(sockets.length).toBeGreaterThanOrEqual(2);
      expect(sockets[0].terminated).toBe(true);
    } finally {
      relay.close();
    }
  });
});
