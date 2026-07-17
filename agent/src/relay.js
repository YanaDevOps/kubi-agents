import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { loadLocalNamespaces, resolveAgentRuntimeConfigForSelector } from './kube.js';

function relayUrl(controlPlaneUrl) {
  const url = new URL('/api/agent/relay', controlPlaneUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function requestStream(input) {
  const request = Readable.from(input.body ? [Buffer.from(input.body)] : []);
  request.url = input.url;
  request.method = input.method || 'GET';
  request.headers = input.headers || {};
  return request;
}

export function createAgentRelayClient(options) {
  let socket = null;
  let reconnectTimer = null;
  let closed = false;
  let backoffMs = 1_000;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.min(1_000, backoffMs / 2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs + jitter);
    backoffMs = Math.min(30_000, backoffMs * 2);
  };

  const respond = (requestId, result, error) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'response', requestId, ...(error ? { error } : { result }) }));
  };

  const runCommand = async (message) => {
    const command = message.command || {};
    if (command.kind === 'http') {
      return options.dispatch(requestStream(command.request || {}));
    }
    if (command.kind === 'probe') {
      const runtimeConfig = resolveAgentRuntimeConfigForSelector(options.runtimeConfig, command.selector);
      const namespaces = await loadLocalNamespaces(runtimeConfig);
      if (namespaces.partial || namespaces.availability === 'unavailable') {
        throw new Error(namespaces.issues?.[0]?.message || 'The Kubernetes API probe did not complete successfully.');
      }
      return {
        ok: true,
        namespaceCount: namespaces.items.length,
        fetchedAt: namespaces.fetchedAt,
        partial: namespaces.partial
      };
    }
    throw new Error('Unsupported relay command.');
  };

  const connect = () => {
    if (closed) return;
    socket = options.webSocketFactory?.(relayUrl(options.runtimeConfig.controlPlaneUrl)) ??
      new WebSocket(relayUrl(options.runtimeConfig.controlPlaneUrl), { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'hello',
        agentId: options.runtimeConfig.agentId,
        agentSecret: options.runtimeConfig.agentSecret,
        platform: options.platform,
        version: options.version,
        capabilities: options.capabilities
      }));
    });
    socket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'ready') {
        backoffMs = 1_000;
        options.onStatus?.('connected');
        return;
      }
      if (message.type !== 'request' || typeof message.requestId !== 'string') return;
      try {
        respond(message.requestId, await runCommand(message));
      } catch (error) {
        respond(message.requestId, undefined, error instanceof Error ? error.message : 'Agent relay command failed.');
      }
    });
    socket.on('close', () => {
      options.onStatus?.('disconnected');
      scheduleReconnect();
    });
    socket.on('error', (error) => {
      options.onError?.(error instanceof Error ? error : new Error('Agent relay connection failed.'));
    });
  };

  return {
    start() {
      connect();
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
    }
  };
}
