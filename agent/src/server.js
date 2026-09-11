import http from 'node:http';
import { introspectDiscoveryAccess, introspectMCPAccess, introspectRuntimeAccess, syncDiscoveredCandidates } from './control-plane.js';
import {
  scanLocalAccessDiscovery,
  loadLocalComponentInventory,
  loadLocalDeliveryActivity,
  loadLocalDeliveryEvents,
  loadLocalRuntimeCapability,
  loadLocalBackupActivity,
  loadLocalCrds,
  loadLocalCrdObjects,
  loadLocalDomainHealth,
  loadLocalGhostResources,
  loadLocalImageRisk,
  loadLocalPolicyPosture,
  loadLocalAutoscaling,
  loadLocalJobs,
  loadLocalJobLogs,
  loadLocalMetrics,
  loadLocalClusterOverview,
  loadLocalNamespaces,
  loadLocalNodes,
  loadLocalPods,
  loadLocalPodDns,
  loadLocalPodLogs,
  loadLocalPodRelatedResources,
  loadLocalPorts,
  loadLocalTraffic,
  loadLocalCni,
  loadLocalVip,
  loadLocalRbac,
  loadLocalSecrets,
  loadLocalConfigMaps,
  loadLocalConfigMapContent,
  loadLocalServices,
  loadLocalServiceMesh,
  loadLocalStorage,
  loadLocalStorageEvents,
  loadLocalTopology,
  loadLocalValidation,
  loadLocalWorkloads,
  resolveAgentRuntimeConfigForSelector
} from './kube.js';
import {
  alertingRuleOptions,
  loadAlertingConfig,
  loadAlertingHistory,
  loadAlertingSummary,
  saveAlertingConfig,
  testAlertingChannel
} from './alerting.js';
import { MCP_RESOURCE_CATALOG, mcpToolDefinitions, summarizePolicyPostureForMCP } from '../../src/shared/mcp-catalog.js';
import { loadLocalStorageDriverOverview } from './storage-drivers.js';
import { loadLocalCiPipelines } from './ci/index.js';

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  if (status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
  });
}

function readBearerToken(request) {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ')) {
    return null;
  }
  return value.slice('Bearer '.length).trim() || null;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(value) {
  const origin = normalizeOrigin(value);
  if (!origin) return false;
  const hostname = new URL(origin).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function allowedBrowserOrigin(runtimeConfig, request) {
  const originHeader = request.headers.origin;
  if (!originHeader) {
    return { origin: null, allowed: true };
  }

  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    return { origin: null, allowed: false };
  }

  const controlPlaneOrigin = normalizeOrigin(runtimeConfig.controlPlaneUrl);
  if (controlPlaneOrigin && origin === controlPlaneOrigin) {
    return { origin, allowed: true };
  }

  if (process.env.NODE_ENV !== 'production' && isLoopbackOrigin(origin)) {
    return { origin, allowed: true };
  }

  return { origin, allowed: false };
}

function corsHeaders(origin) {
  if (!origin) {
    return {};
  }

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-max-age': '60',
    vary: 'Origin'
  };
}

function crdQueryPayload(searchParams) {
  const csv = (key) => (searchParams.get(key) || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return {
    name: searchParams.get('name') || '',
    group: searchParams.get('group') || '',
    kind: searchParams.get('kind') || '',
    plural: searchParams.get('plural') || '',
    scope: searchParams.get('scope') || '',
    versions: csv('versions'),
    storedVersions: csv('storedVersions'),
    categories: csv('categories'),
    established: searchParams.get('established') === 'true',
    namesAccepted: searchParams.get('namesAccepted') === 'true',
    createdAt: searchParams.get('createdAt') || undefined
  };
}

function buildMCPCapabilities(runtimeConfig) {
  const baseUrl = 'http://127.0.0.1:47641/v1';
  return {
    name: 'kubi-mcp',
    version: runtimeConfig.version || 'unknown',
    mode: 'observe-only',
    readOnly: true,
    generatedAt: new Date().toISOString(),
    capabilities: {
      resources: MCP_RESOURCE_CATALOG.map((resource) => ({
        name: resource.id,
        description: resource.description,
        endpoint: `${baseUrl}${resource.path.slice('/v1'.length)}`
      })),
      tools: mcpToolDefinitions()
    },
    safety: [
      'KUBI MCP is observe-only: mutating cluster requests are not exposed.',
      'Cluster data stays customer-side through the local KUBI agent.',
      'Do not expose the local MCP endpoint to the public internet.'
    ]
  };
}

export function createAgentLoopbackServer(options) {
  const runtimeIntrospectionCache = new Map();
  const mcpIntrospectionCache = new Map();
  const discoveryIntrospectionCache = new Map();
  const pendingIntrospection = new Map();
  const now = options.now || Date.now;
  const runtimeIntrospectionCacheTtlMs = options.runtimeIntrospectionCacheTtlMs ?? 2_000;
  const overviewProvider = options.overviewProvider || loadLocalClusterOverview;
  const capabilityProvider = options.capabilityProvider || loadLocalRuntimeCapability;
  const namespacesProvider = options.namespacesProvider || loadLocalNamespaces;
  const nodesProvider = options.nodesProvider || loadLocalNodes;
  const podsProvider = options.podsProvider || loadLocalPods;
  const podDnsProvider = options.podDnsProvider || loadLocalPodDns;
  const podLogsProvider = options.podLogsProvider || loadLocalPodLogs;
  const podRelatedResourcesProvider = options.podRelatedResourcesProvider || loadLocalPodRelatedResources;
  const workloadsProvider = options.workloadsProvider || loadLocalWorkloads;
  const servicesProvider = options.servicesProvider || loadLocalServices;
  const secretsProvider = options.secretsProvider || loadLocalSecrets;
  const configMapsProvider = options.configMapsProvider || loadLocalConfigMaps;
  const configMapContentProvider = options.configMapContentProvider || loadLocalConfigMapContent;
  const crdsProvider = options.crdsProvider || loadLocalCrds;
  const crdObjectsProvider = options.crdObjectsProvider || loadLocalCrdObjects;
  const storageProvider = options.storageProvider || loadLocalStorage;
  const storageDriverProvider = options.storageDriverProvider || loadLocalStorageDriverOverview;
  const storageEventsProvider = options.storageEventsProvider || loadLocalStorageEvents;
  const componentsProvider = options.componentsProvider || loadLocalComponentInventory;
  const deliveryActivityProvider = options.deliveryActivityProvider || loadLocalDeliveryActivity;
  const ciPipelinesProvider = options.ciPipelinesProvider || loadLocalCiPipelines;
  const deliveryEventsProvider = options.deliveryEventsProvider || loadLocalDeliveryEvents;
  const jobsProvider = options.jobsProvider || loadLocalJobs;
  const jobLogsProvider = options.jobLogsProvider || loadLocalJobLogs;
  const metricsProvider = options.metricsProvider || loadLocalMetrics;
  const backupActivityProvider = options.backupActivityProvider || loadLocalBackupActivity;
  const alertingSummaryProvider = options.alertingSummaryProvider || loadAlertingSummary;
  const alertingConfigProvider = options.alertingConfigProvider || loadAlertingConfig;
  const alertingSaveProvider = options.alertingSaveProvider || saveAlertingConfig;
  const alertingHistoryProvider = options.alertingHistoryProvider || loadAlertingHistory;
  const alertingTestProvider = options.alertingTestProvider || testAlertingChannel;
  const alertingRuleOptionsProvider =
    options.alertingRuleOptionsProvider || alertingRuleOptions;
  const serviceMeshProvider = options.serviceMeshProvider || loadLocalServiceMesh;
  const validationProvider = options.validationProvider || loadLocalValidation;
  const domainHealthProvider = options.domainHealthProvider || loadLocalDomainHealth;
  const ghostResourcesProvider = options.ghostResourcesProvider || loadLocalGhostResources;
  const imageRiskProvider = options.imageRiskProvider || loadLocalImageRisk;
  const policyPostureProvider = options.policyPostureProvider || loadLocalPolicyPosture;
  const autoscalingProvider = options.autoscalingProvider || loadLocalAutoscaling;
  const rbacProvider = options.rbacProvider || loadLocalRbac;
  const portsProvider = options.portsProvider || loadLocalPorts;
  const trafficProvider = options.trafficProvider || loadLocalTraffic;
  const cniProvider = options.cniProvider || loadLocalCni;
  const vipProvider = options.vipProvider || loadLocalVip;
  const topologyProvider = options.topologyProvider || loadLocalTopology;
  const introspectClient = options.introspectClient || introspectRuntimeAccess;
  const introspectMCPClient = options.introspectMCPClient || introspectMCPAccess;
  const introspectDiscoveryClient = options.introspectDiscoveryClient || introspectDiscoveryAccess;
  const discoveryScanProvider =
    options.discoveryScanProvider ||
    (async (runtimeConfig) => {
      const result = scanLocalAccessDiscovery(runtimeConfig);
      const lastError = result.sourceCount === 0 && result.warnings.length > 0 ? result.warnings.join(' ') : undefined;
      const sync = await syncDiscoveredCandidates({
        controlPlaneUrl: runtimeConfig.controlPlaneUrl,
        agentId: runtimeConfig.agentId,
        agentSecret: runtimeConfig.agentSecret,
        candidates: result.candidates,
        sourceCount: result.sourceCount,
        ...(lastError ? { lastError } : {})
      });

      return {
        ...sync,
        warnings: result.warnings
      };
    });

  async function authorizeRuntime(request) {
    const accessToken = readBearerToken(request);
    if (!accessToken) {
      return null;
    }

    const isMcp = accessToken.startsWith('kubi_mcp_');
    const cache = isMcp ? mcpIntrospectionCache : runtimeIntrospectionCache;
    const cached = cache.get(accessToken);
    if (cached && cached.expiresAt > now()) {
      return cached.introspection;
    }

    if (pendingIntrospection.has(accessToken)) return pendingIntrospection.get(accessToken);
    const pending = (async () => {
      const identity = {
        controlPlaneUrl: options.runtimeConfig.controlPlaneUrl,
        agentId: options.runtimeConfig.agentId,
        agentSecret: options.runtimeConfig.agentSecret
      };
      let introspection;
      if (isMcp) {
        introspection = { ...await introspectMCPClient({ ...identity, mcpToken: accessToken }), mcpAccess: true };
      } else {
        try {
          introspection = await introspectClient({ ...identity, accessToken });
        } catch (error) {
          // Preserve compatibility with pre-prefix MCP tokens, but never turn a
          // control-plane timeout into a second remote request.
          const message = error instanceof Error ? error.message.toLowerCase() : '';
          if (/timeout|timed out|network|fetch failed|unreachable/.test(message)) throw error;
          introspection = { ...await introspectMCPClient({ ...identity, mcpToken: accessToken }), mcpAccess: true };
        }
      }
      const timestamp = now();
      for (const [token, entry] of cache) if (entry.expiresAt <= timestamp) cache.delete(token);
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(accessToken, {
        introspection,
        expiresAt: isMcp ? timestamp + runtimeIntrospectionCacheTtlMs
          : Math.min(Date.parse(introspection.expiresAt), timestamp + runtimeIntrospectionCacheTtlMs)
      });
      return introspection;
    })();
    pendingIntrospection.set(accessToken, pending);
    try {
      return await pending;
    } finally {
      pendingIntrospection.delete(accessToken);
    }
  }

  async function authorizeDiscovery(request) {
    const accessToken = readBearerToken(request);
    if (!accessToken) {
      return null;
    }

    const cached = discoveryIntrospectionCache.get(accessToken);
    if (cached && Date.parse(cached.expiresAt) > Date.now()) {
      return cached;
    }

    const introspection = await introspectDiscoveryClient({
      controlPlaneUrl: options.runtimeConfig.controlPlaneUrl,
      agentId: options.runtimeConfig.agentId,
      agentSecret: options.runtimeConfig.agentSecret,
      accessToken
    });
    discoveryIntrospectionCache.set(accessToken, introspection);
    return introspection;
  }

  async function dispatchRequest(request, timings) {
    if (!request.url) {
      return {
        status: 404,
        payload: { message: 'Not found.' },
        headers: {}
      };
    }

    const url = new URL(request.url, 'http://127.0.0.1:47641');
    const originCheck = allowedBrowserOrigin(options.runtimeConfig, request);
    const responseCorsHeaders = corsHeaders(originCheck.origin);

    if (request.method === 'OPTIONS') {
      if (!originCheck.allowed || !originCheck.origin) {
        return {
          status: 403,
          payload: { message: 'The local agent rejected this browser origin.' },
          headers: responseCorsHeaders
        };
      }

      return {
        status: 204,
        payload: null,
        headers: responseCorsHeaders
      };
    }

    if (!originCheck.allowed) {
      return {
        status: 403,
        payload: { message: 'The local agent rejected this browser origin.' },
        headers: responseCorsHeaders
      };
    }

    if (url.pathname === '/v1/discovery/scan') {
      if (request.method !== 'POST') {
        return {
          status: 404,
          payload: { message: 'Not found.' },
          headers: responseCorsHeaders
        };
      }

      let discoveryIntrospection;
      try {
        discoveryIntrospection = await authorizeDiscovery(request);
      } catch (error) {
        return {
          status: 401,
          payload: {
            message: error instanceof Error ? error.message : 'The discovery token could not be introspected.'
          },
          headers: responseCorsHeaders
        };
      }

      if (!discoveryIntrospection) {
        return {
          status: 401,
          payload: { message: 'A discovery bearer token is required.' },
          headers: responseCorsHeaders
        };
      }

      try {
        const result = await discoveryScanProvider(options.runtimeConfig);
        return {
          status: 200,
          payload: {
            ok: true,
            workspaceId: discoveryIntrospection.workspaceId,
            agentId: discoveryIntrospection.agentId,
            lastScannedAt: result.lastScannedAt,
            sourceCount: result.sourceCount,
            syncedCount: result.syncedCount,
            status: result.status,
            warnings: result.warnings ?? []
          },
          headers: responseCorsHeaders
        };
      } catch (error) {
        return {
          status: 502,
          payload: {
            message: error instanceof Error ? error.message : 'The local agent could not refresh discovery.'
          },
          headers: responseCorsHeaders
        };
      }
    }

    let introspection;
    const authorizationStartedAt = Date.now();
    try {
      introspection = await authorizeRuntime(request);
    } catch (error) {
      return {
        status: 401,
        payload: {
          message: error instanceof Error ? error.message : 'The runtime token could not be introspected.'
        },
        headers: responseCorsHeaders
      };
    } finally {
      timings.authorizeMs = Date.now() - authorizationStartedAt;
    }

    if (!introspection) {
      return {
        status: 401,
        payload: { message: 'A runtime bearer token is required.' },
        headers: responseCorsHeaders
      };
    }

    if (introspection.mcpAccess && (
      request.method !== 'GET' ||
      (!MCP_RESOURCE_CATALOG.some((resource) => resource.path === url.pathname) &&
        !['/v1/health', '/v1/capability', '/v1/mcp'].includes(url.pathname))
    )) {
      return { status: 403, payload: { message: 'Resource is not in the MCP read-only allowlist.' }, headers: responseCorsHeaders };
    }

    let runtimeConfig;
    const selectorStartedAt = Date.now();
    try {
      runtimeConfig = (options.runtimeConfigResolver || resolveAgentRuntimeConfigForSelector)(
        options.runtimeConfig,
        introspection.connectionSelector
      );
    } catch (error) {
      return {
        status: 403,
        payload: {
          message: error instanceof Error ? error.message : 'The runtime session kubeconfig context selector is invalid.'
        },
        headers: responseCorsHeaders
      };
    } finally {
      timings.selectorMs = Date.now() - selectorStartedAt;
    }

    const hasManageScope = Array.isArray(introspection.scopes) && introspection.scopes.includes('runtime:manage');
    if (url.pathname === '/v1/alerting' || url.pathname.startsWith('/v1/alerting/')) {
      if (!hasManageScope) {
        return {
          status: 403,
          payload: { message: 'Alerting requires a Premium runtime manage session.' },
          headers: responseCorsHeaders
        };
      }

      try {
        if (url.pathname === '/v1/alerting' && request.method === 'GET') {
          return {
            status: 200,
            payload: await alertingSummaryProvider(runtimeConfig),
            headers: responseCorsHeaders
          };
        }
        if (url.pathname === '/v1/alerting/config' && request.method === 'GET') {
          return {
            status: 200,
            payload: await alertingConfigProvider(runtimeConfig),
            headers: responseCorsHeaders
          };
        }
        if (url.pathname === '/v1/alerting/config' && request.method === 'PUT') {
          const body = await readJsonBody(request);
          return {
            status: 200,
            payload: await alertingSaveProvider(runtimeConfig, body),
            headers: responseCorsHeaders
          };
        }
        if (url.pathname === '/v1/alerting/history' && request.method === 'GET') {
          return {
            status: 200,
            payload: { items: await alertingHistoryProvider(runtimeConfig), timestamp: new Date().toISOString() },
            headers: responseCorsHeaders
          };
        }
        if (url.pathname === '/v1/alerting/test' && request.method === 'POST') {
          const body = await readJsonBody(request);
          return {
            status: 200,
            payload: await alertingTestProvider(runtimeConfig, typeof body.channelId === 'string' ? body.channelId : ''),
            headers: responseCorsHeaders
          };
        }
        if (url.pathname === '/v1/alerting/rule-options' && request.method === 'GET') {
          return {
            status: 200,
            payload: await alertingRuleOptionsProvider(runtimeConfig, {
              kind: url.searchParams.get('kind') || 'pod',
              namespace: url.searchParams.get('namespace') || 'all'
            }),
            headers: responseCorsHeaders
          };
        }
      } catch (error) {
        return {
          status: 502,
          payload: {
            message: error instanceof Error ? error.message : 'The local agent could not process alerting settings.'
          },
          headers: responseCorsHeaders
        };
      }
    }

    if (request.method !== 'GET') {
      return {
        status: 404,
        payload: { message: 'Not found.' },
        headers: responseCorsHeaders
      };
    }

    if (url.pathname === '/v1/health') {
      return {
        status: 200,
        payload: {
          ok: true,
          workspaceId: introspection.workspaceId,
          agentId: introspection.agentId,
          connectionId: introspection.connectionId,
          agentVersion: runtimeConfig.version || 'unknown',
          runtimeApiVersion: runtimeConfig.runtimeApiVersion || undefined,
          policyPosture: true,
          autoscalingCapacity: true,
          buildId: runtimeConfig.buildId || undefined,
          expiresAt: introspection.expiresAt,
          scopes: introspection.scopes
        },
        headers: responseCorsHeaders
      };
    }

    if (url.pathname === '/v1/mcp') {
      return {
        status: 200,
        payload: buildMCPCapabilities(runtimeConfig),
        headers: responseCorsHeaders
      };
    }

    if (url.pathname === '/v1/capability') {
      return {
        status: 200,
        payload: await capabilityProvider({
          ...runtimeConfig,
          workspaceId: introspection.workspaceId,
          connectionId: introspection.connectionId
        }),
        headers: responseCorsHeaders
      };
    }

    try {
      if (url.pathname === '/v1/overview') {
        return {
          status: 200,
          payload: await overviewProvider({
            ...runtimeConfig,
            connectionId: introspection.connectionId
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/namespaces') {
        return {
          status: 200,
          payload: await namespacesProvider(runtimeConfig),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/nodes') {
        return {
          status: 200,
          payload: await nodesProvider(runtimeConfig),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/pods') {
        return {
          status: 200,
          payload: await podsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/pods/logs') {
        return {
          status: 200,
          payload: await podLogsProvider(runtimeConfig, {
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || '',
            container: url.searchParams.get('container') || undefined,
            tail: url.searchParams.get('tail') || undefined
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/pods/dns') {
        return {
          status: 200,
          payload: await podDnsProvider(runtimeConfig, {
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/pods/related-resources') {
        return {
          status: 200,
          payload: await podRelatedResourcesProvider(runtimeConfig, {
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/jobs') {
        return {
          status: 200,
          payload: await jobsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/jobs/logs') {
        return {
          status: 200,
          payload: await jobLogsProvider(runtimeConfig, {
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || '',
            tail: url.searchParams.get('tail') || undefined
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/metrics') {
        return {
          status: 200,
          payload: await metricsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/workloads') {
        return {
          status: 200,
          payload: await workloadsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/services') {
        return {
          status: 200,
          payload: await servicesProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/secrets') {
        return {
          status: 200,
          payload: await secretsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/configmaps') {
        return {
          status: 200,
          payload: await configMapsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/configmaps/content') {
        return {
          status: 200,
          payload: await configMapContentProvider(runtimeConfig, {
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/crds') {
        return {
          status: 200,
          payload: await crdsProvider(runtimeConfig),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/crd-objects') {
        return {
          status: 200,
          payload: await crdObjectsProvider(runtimeConfig, {
            crd: crdQueryPayload(url.searchParams),
            namespaceScope: url.searchParams.get('ns')
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/storage') {
        return {
          status: 200,
          payload: await storageProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/storage-driver-overview') {
        return {
          status: 200,
          payload: await storageDriverProvider(runtimeConfig, {
            driver: url.searchParams.get('driver') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/storage-events') {
        return {
          status: 200,
          payload: await storageEventsProvider(runtimeConfig, {
            kind: url.searchParams.get('kind') || '',
            namespace: url.searchParams.get('ns'),
            name: url.searchParams.get('name') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/backup-activity') {
        return {
          status: 200,
          payload: await backupActivityProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/delivery-activity') {
        return {
          status: 200,
          payload: await deliveryActivityProvider(
            runtimeConfig,
            url.searchParams.get('ns'),
            url.searchParams.get('provider'),
            url.searchParams.get('section')
          ),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/delivery-events') {
        return {
          status: 200,
          payload: await deliveryEventsProvider(runtimeConfig, {
            providerId: url.searchParams.get('provider') || '',
            kind: url.searchParams.get('kind') || '',
            namespace: url.searchParams.get('ns') || '',
            name: url.searchParams.get('name') || ''
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/ci-pipelines') {
        return {
          status: 200,
          payload: await ciPipelinesProvider(
            runtimeConfig,
            url.searchParams.get('provider'),
            url.searchParams.get('instance')
          ),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/components') {
        return {
          status: 200,
          payload: await componentsProvider(runtimeConfig),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/service-mesh') {
        return {
          status: 200,
          payload: await serviceMeshProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/validation') {
        return {
          status: 200,
          payload: await validationProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/domain-health') {
        return {
          status: 200,
          payload: await domainHealthProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/ghost-resources') {
        return {
          status: 200,
          payload: await ghostResourcesProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/image-risk') {
        return {
          status: 200,
          payload: await imageRiskProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/policy-posture') {
        const namespace = url.searchParams.get('ns');
        if (namespace && namespace !== 'all' && (namespace.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))) {
          return { status: 400, payload: { message: 'Invalid Kubernetes namespace.' }, headers: responseCorsHeaders };
        }
        if (!Array.isArray(introspection.scopes) || !introspection.scopes.includes('runtime:read')) {
          return { status: 403, payload: { message: 'A runtime read scope is required.' }, headers: responseCorsHeaders };
        }
        const payload = await policyPostureProvider(runtimeConfig, namespace === 'all' ? null : namespace, {
          forceRefresh: url.searchParams.get('forceRefresh') === 'true'
        });
        return {
          status: 200,
          payload: introspection.mcpAccess ? summarizePolicyPostureForMCP(payload) : payload,
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/autoscaling') {
        const namespace = url.searchParams.get('ns');
        const view = url.searchParams.get('view') || 'full';
        if (namespace && namespace !== 'all' && (namespace.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))) {
          return { status: 400, payload: { message: 'Invalid Kubernetes namespace.' }, headers: responseCorsHeaders };
        }
        if (!Array.isArray(introspection.scopes) || !introspection.scopes.includes('runtime:read')) {
          return { status: 403, payload: { message: 'A runtime read scope is required.' }, headers: responseCorsHeaders };
        }
        if (!['summary', 'hpa', 'vpa', 'keda', 'pdb', 'capacity', 'node-scaling', 'full'].includes(view)) {
          return { status: 400, payload: { message: 'Invalid autoscaling view.' }, headers: responseCorsHeaders };
        }
        return {
          status: 200,
          payload: await autoscalingProvider(runtimeConfig, namespace === 'all' ? null : namespace, {
            view,
            forceRefresh: url.searchParams.get('forceRefresh') === 'true'
          }),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/rbac') {
        return {
          status: 200,
          payload: await rbacProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/ports') {
        return {
          status: 200,
          payload: await portsProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/traffic') {
        return {
          status: 200,
          payload: await trafficProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/cni') {
        return {
          status: 200,
          payload: await cniProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/vip') {
        return {
          status: 200,
          payload: await vipProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }

      if (url.pathname === '/v1/topology') {
        return {
          status: 200,
          payload: await topologyProvider(runtimeConfig, url.searchParams.get('ns')),
          headers: responseCorsHeaders
        };
      }
    } catch (error) {
      return {
        status: 502,
        payload: {
          message: introspection.mcpAccess && url.pathname === '/v1/policy-posture'
            ? 'The agent could not load the Policy & Posture summary.'
            : error instanceof Error ? error.message : 'The local agent could not read cluster data.'
        },
        headers: responseCorsHeaders
      };
    }

    return {
      status: 404,
      payload: { message: 'Not found.' },
      headers: responseCorsHeaders
    };
  }

  async function dispatch(request) {
    const startedAt = Date.now();
    const timings = { authorizeMs: 0, selectorMs: 0 };
    const result = await dispatchRequest(request, timings);
    const durationMs = Date.now() - startedAt;
    const rawId = request.headers?.['x-kubi-request-id'];
    options.onRuntimeRequest?.({
      requestId: typeof rawId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(rawId) ? rawId : 'local',
      endpoint: new URL(request.url || '/', 'http://localhost').pathname,
      status: result.status,
      durationMs,
      ...timings,
      resourceMs: Math.max(0, durationMs - timings.authorizeMs - timings.selectorMs)
    });
    return result;
  }

  const server = http.createServer(async (request, response) => {
    const result = await dispatch(request);
    json(response, result.status, result.payload, result.headers);
  });

  return {
    listen(port = 47641, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    dispatch
  };
}
