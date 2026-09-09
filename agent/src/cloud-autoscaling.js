import fs from 'node:fs';

const cache = new Map();
const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

function matches(profile, runtimeConfig) {
  if (profile.clusterFingerprint) return profile.clusterFingerprint === runtimeConfig.clusterFingerprint;
  return profile.context === '*' || profile.context === runtimeConfig.kubeContext;
}

function readSecret(path) {
  if (!path) return '';
  const stat = fs.statSync(path);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Credential file ${path} must not be readable by group or others.`);
  return fs.readFileSync(path, 'utf8').trim();
}

function assertCredentialFile(path) {
  if (!path) return;
  const stat = fs.statSync(path);
  if (!stat.isFile()) throw new Error(`Credential path ${path} is not a regular file.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Credential file ${path} must not be readable by group or others.`);
}

function source(id, state, count = 0, message) {
  return { id, status: state, count, ...(message ? { message } : {}), ...(state === 'error' ? { partial: true } : {}) };
}

function pool(provider, profile, name, state, current, minimum, maximum, details = {}) {
  return {
    id: `${provider}:${profile.id}:${name}`,
    kind: 'ManagedNodePool',
    name,
    state: state || 'Unknown',
    provider,
    currentReplicas: Number(current || 0),
    minReplicas: minimum == null ? undefined : Number(minimum),
    maxReplicas: maximum == null ? undefined : Number(maximum),
    details
  };
}

async function withTimeout(promise, seconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cloud API request timed out.')), seconds * 1_000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function aws(profile) {
  assertCredentialFile(profile.credentialsFile);
  const [{ EKSClient, ListNodegroupsCommand, DescribeNodegroupCommand }, { fromIni }] = await Promise.all([
    import('@aws-sdk/client-eks'), import('@aws-sdk/credential-providers')
  ]);
  const credentials = profile.profile || profile.credentialsFile
    ? fromIni({ profile: profile.profile, filepath: profile.credentialsFile })
    : undefined;
  const client = new EKSClient({ region: profile.region, ...(credentials ? { credentials } : {}) });
  const listed = await withTimeout(client.send(new ListNodegroupsCommand({ clusterName: profile.clusterName })), profile.timeoutSeconds);
  const rows = await Promise.all((listed.nodegroups || []).slice(0, 100).map(async (name) => {
    const response = await withTimeout(client.send(new DescribeNodegroupCommand({ clusterName: profile.clusterName, nodegroupName: name })), profile.timeoutSeconds);
    const item = response.nodegroup || {};
    return pool('AWS EKS', profile, name, item.status, item.scalingConfig?.desiredSize, item.scalingConfig?.minSize, item.scalingConfig?.maxSize, {
      capacityType: item.capacityType,
      instanceTypes: item.instanceTypes || [],
      zones: item.subnets?.length ? `${item.subnets.length} configured subnet(s)` : undefined
    });
  }));
  client.destroy?.();
  return rows;
}

async function gcp(profile) {
  assertCredentialFile(profile.credentialsFile);
  const [{ ClusterManagerClient }, { InstanceGroupManagersClient, RegionInstanceGroupManagersClient }] = await Promise.all([
    import('@google-cloud/container'), import('@google-cloud/compute')
  ]);
  const client = new ClusterManagerClient(profile.credentialsFile ? { keyFilename: profile.credentialsFile } : {});
  const computeOptions = profile.credentialsFile ? { keyFilename: profile.credentialsFile } : {};
  const zonal = new InstanceGroupManagersClient(computeOptions);
  const regional = new RegionInstanceGroupManagersClient(computeOptions);
  const parent = `projects/${profile.projectId}/locations/${profile.location}/clusters/${profile.clusterName}`;
  const [response] = await withTimeout(client.listNodePools({ parent }), profile.timeoutSeconds);
  const rows = await Promise.all((response.nodePools || []).slice(0, 100).map(async (item) => {
    let current = 0;
    for (const groupUrl of item.instanceGroupUrls || []) {
      const match = groupUrl.match(/\/(zones|regions)\/([^/]+)\/instanceGroupManagers\/([^/]+)$/);
      if (!match) continue;
      const request = { project: profile.projectId, [match[1] === 'zones' ? 'zone' : 'region']: match[2], instanceGroupManager: match[3] };
      const [group] = await withTimeout((match[1] === 'zones' ? zonal : regional).get(request), profile.timeoutSeconds);
      current += Number(group.targetSize || 0);
    }
    return pool('Google GKE', profile, item.name || 'unnamed', item.status, current,
    item.autoscaling?.minNodeCount, item.autoscaling?.maxNodeCount, {
      autoscaling: Boolean(item.autoscaling?.enabled),
      locations: item.locations || [],
      machineType: item.config?.machineType,
      spot: Boolean(item.config?.spot || item.config?.preemptible)
    });
  }));
  await Promise.all([client.close?.(), zonal.close?.(), regional.close?.()]);
  return rows;
}

async function azure(profile) {
  const [{ ContainerServiceClient }, identity] = await Promise.all([
    import('@azure/arm-containerservice'), import('@azure/identity')
  ]);
  const credential = profile.tenantIdFile
    ? new identity.ClientSecretCredential(readSecret(profile.tenantIdFile), readSecret(profile.clientIdFile), readSecret(profile.clientSecretFile))
    : new identity.DefaultAzureCredential();
  const client = new ContainerServiceClient(credential, profile.subscriptionId);
  const rows = [];
  for await (const item of client.agentPools.list(profile.resourceGroup, profile.clusterName)) {
    if (rows.length >= 100) break;
    rows.push(pool('Azure AKS', profile, item.name || 'unnamed', item.provisioningState, item.count,
      item.enableAutoScaling ? item.minCount : item.count, item.enableAutoScaling ? item.maxCount : item.count, {
        autoscaling: Boolean(item.enableAutoScaling), mode: item.mode, vmSize: item.vmSize, zones: item.availabilityZones || [],
        scaleDownMode: item.scaleDownMode
      }));
  }
  return rows;
}

const loaders = { aws, gcp, azure };

async function load(runtimeConfig) {
  const sources = [];
  const providers = [];
  const pools = [];
  for (const provider of Object.keys(loaders)) {
    const config = runtimeConfig.cloudAutoscaling?.[provider];
    if (!config?.enabled) {
      sources.push(source(`cloud-${provider}`, 'not-configured', 0, 'Adapter is disabled in the local agent configuration.'));
      continue;
    }
    const profiles = (config.profiles || []).filter((profile) => matches(profile, runtimeConfig));
    if (!profiles.length) {
      sources.push(source(`cloud-${provider}`, 'not-configured', 0, 'No profile matches the active Kubernetes context.'));
      continue;
    }
    for (const profile of profiles) {
      try {
        const rows = await loaders[provider](profile);
        pools.push(...rows);
        providers.push({ id: `${provider}:${profile.id}`, kind: 'CloudNodeAutoscaler', name: rows[0]?.provider || provider.toUpperCase(),
          state: rows.some((item) => !/active|running|ready|succeeded/i.test(item.state)) ? 'Degraded' : 'Ready', provider: rows[0]?.provider || provider.toUpperCase(), details: { pools: rows.length } });
        sources.push(source(`cloud-${provider}:${profile.id}`, 'available', rows.length));
      } catch {
        sources.push(source(`cloud-${provider}:${profile.id}`, 'error', 0, 'Cloud node-pool inventory could not be read. Check local credentials and permissions.'));
      }
    }
  }
  return { sources, providers, pools, claims: [], findings: [] };
}

export async function loadCloudAutoscaling(runtimeConfig) {
  const key = JSON.stringify([runtimeConfig.kubeContext || '', runtimeConfig.cloudAutoscaling || {}]);
  const current = cache.get(key);
  if (current?.inflight) return current.inflight;
  if (current?.value && current.freshUntil > Date.now()) return current.value;
  const entry = current || { value: null, freshUntil: 0, staleUntil: 0, inflight: null };
  entry.inflight = load(runtimeConfig).then((value) => {
    entry.value = value;
    entry.freshUntil = Date.now() + FRESH_MS;
    entry.staleUntil = Date.now() + STALE_MS;
    return value;
  }).catch((error) => {
    if (entry.value && entry.staleUntil > Date.now()) return entry.value;
    throw error;
  }).finally(() => { entry.inflight = null; });
  cache.set(key, entry);
  return entry.inflight;
}
