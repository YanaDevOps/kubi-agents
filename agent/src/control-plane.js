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

export async function registerAgentWithControlPlane(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      pairingToken: input.pairingToken,
      displayName: input.displayName,
      platform: input.platform,
      version: input.version,
      capabilities: input.capabilities
    })
  });

  return parseControlPlaneResponse(response);
}

export async function sendAgentHeartbeat(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      platform: input.platform,
      version: input.version,
      capabilities: input.capabilities
    })
  });

  return parseControlPlaneResponse(response);
}

export async function rotateAgentCredentials(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/credentials/rotate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret
    })
  });

  return parseControlPlaneResponse(response);
}

export async function syncDiscoveredCandidates(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/discovery/candidates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      candidates: input.candidates,
      ...(typeof input.sourceCount === 'number' ? { sourceCount: input.sourceCount } : {}),
      ...(typeof input.lastError === 'string' && input.lastError.trim() ? { lastError: input.lastError.trim() } : {})
    })
  });

  return parseControlPlaneResponse(response);
}

export async function introspectDiscoveryAccess(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/discovery/introspect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      accessToken: input.accessToken
    })
  });

  return parseControlPlaneResponse(response);
}

export async function introspectRuntimeAccess(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/runtime/introspect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      accessToken: input.accessToken
    })
  });

  return parseControlPlaneResponse(response);
}

export async function introspectMCPAccess(input) {
  const response = await fetch(`${normalizeOrigin(input.controlPlaneUrl)}/api/agent/mcp/introspect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      mcpToken: input.mcpToken
    })
  });

  return parseControlPlaneResponse(response);
}
