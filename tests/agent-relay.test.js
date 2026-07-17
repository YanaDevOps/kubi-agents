import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createAgentRelayClient } from '../agent/src/relay.js';

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
});
