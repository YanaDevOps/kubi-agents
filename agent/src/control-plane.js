function normalizeOrigin(value) {
  const url = new URL(value);
  return url.origin;
}

async function parseControlPlaneResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload.data;
}

async function postControlPlane(input, path, body) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(input.timeoutMs ?? 15_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(`${normalizeOrigin(input.controlPlaneUrl)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return await parseControlPlaneResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Control-plane request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerAgentWithControlPlane(input) {
  return postControlPlane(input, '/api/agent/register', {
    pairingToken: input.pairingToken,
    displayName: input.displayName,
    platform: input.platform,
    version: input.version,
    capabilities: input.capabilities
  });
}

export async function sendAgentHeartbeat(input) {
  return postControlPlane(input, '/api/agent/heartbeat', {
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    platform: input.platform,
    version: input.version,
    capabilities: input.capabilities
  });
}

export async function rotateAgentCredentials(input) {
  return postControlPlane(input, '/api/agent/credentials/rotate', {
    agentId: input.agentId,
    agentSecret: input.agentSecret
  });
}

export async function syncDiscoveredCandidates(input) {
  return postControlPlane(input, '/api/agent/discovery/candidates', {
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    candidates: input.candidates,
    ...(typeof input.sourceCount === 'number' ? { sourceCount: input.sourceCount } : {}),
    ...(typeof input.lastError === 'string' && input.lastError.trim() ? { lastError: input.lastError.trim() } : {})
  });
}

export async function introspectDiscoveryAccess(input) {
  return postControlPlane(input, '/api/agent/discovery/introspect', {
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    accessToken: input.accessToken
  });
}

export async function introspectRuntimeAccess(input) {
  return postControlPlane(input, '/api/agent/runtime/introspect', {
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    accessToken: input.accessToken
  });
}

export async function introspectMCPAccess(input) {
  return postControlPlane(input, '/api/agent/mcp/introspect', {
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    mcpToken: input.mcpToken
  });
}
