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
  let readyTimer = null;
  let livenessTimer = null;
  let closed = false;
  let awaitingPong = false;
  const reconnectBaseDelayMs = Number(options.reconnectBaseDelayMs ?? 1_000);
  const reconnectMaxDelayMs = Number(options.reconnectMaxDelayMs ?? 30_000);
  const reconnectJitterMs = Number(options.reconnectJitterMs ?? 1_000);
  const readyTimeoutMs = Number(options.readyTimeoutMs ?? 15_000);
  const livenessIntervalMs = Number(options.livenessIntervalMs ?? 15_000);
  let backoffMs = reconnectBaseDelayMs;

  const clearSocketTimers = () => {
    if (readyTimer) clearTimeout(readyTimer);
    if (livenessTimer) clearInterval(livenessTimer);
    readyTimer = null;
    livenessTimer = null;
    awaitingPong = false;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const jitter = reconnectJitterMs > 0
      ? Math.floor(Math.random() * Math.min(reconnectJitterMs, backoffMs / 2))
      : 0;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs + jitter);
    backoffMs = Math.min(reconnectMaxDelayMs, Math.max(reconnectBaseDelayMs, backoffMs * 2));
  };

  const startLivenessWatchdog = (activeSocket) => {
    if (livenessTimer) clearInterval(livenessTimer);
    awaitingPong = false;
    livenessTimer = setInterval(() => {
      if (closed || socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        options.onError?.(new Error('Hosted relay connection became stale; reconnecting.'));
        if (typeof activeSocket.terminate === 'function') activeSocket.terminate();
        else activeSocket.close();
        return;
      }
      awaitingPong = true;
      if (typeof activeSocket.ping === 'function') activeSocket.ping();
    }, livenessIntervalMs);
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
    const activeSocket = options.webSocketFactory?.(relayUrl(options.runtimeConfig.controlPlaneUrl)) ??
      new WebSocket(relayUrl(options.runtimeConfig.controlPlaneUrl), { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    socket = activeSocket;
    activeSocket.on('open', () => {
      readyTimer = setTimeout(() => {
        if (socket !== activeSocket || closed) return;
        options.onError?.(new Error('Hosted relay authentication timed out; reconnecting.'));
        if (typeof activeSocket.terminate === 'function') activeSocket.terminate();
        else activeSocket.close();
      }, readyTimeoutMs);
      activeSocket.send(JSON.stringify({
        type: 'hello',
        agentId: options.runtimeConfig.agentId,
        agentSecret: options.runtimeConfig.agentSecret,
        platform: options.platform,
        version: options.version,
        capabilities: options.capabilities
      }));
    });
    activeSocket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'ready') {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        backoffMs = reconnectBaseDelayMs;
        startLivenessWatchdog(activeSocket);
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
    activeSocket.on('pong', () => {
      if (socket === activeSocket) awaitingPong = false;
    });
    activeSocket.on('close', () => {
      if (socket !== activeSocket) return;
      clearSocketTimers();
      socket = null;
      options.onStatus?.('disconnected');
      scheduleReconnect();
    });
    activeSocket.on('error', (error) => {
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
      clearSocketTimers();
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
    }
  };
}
