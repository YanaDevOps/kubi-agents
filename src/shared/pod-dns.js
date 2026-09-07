function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function metadata(resource) {
  const value = record(resource).metadata;
  return {
    name: text(value.name),
    namespace: text(value.namespace),
    labels: record(value.labels)
  };
}

function podReady(pod) {
  const status = record(record(pod).status);
  if (text(status.phase) !== 'Running') return false;
  const ready = records(status.conditions).find((condition) => condition.type === 'Ready');
  if (ready) return ready.status === 'True';
  const containers = records(status.containerStatuses);
  return containers.length === 0 || containers.every((container) => container.ready === true);
}

function selectorMatches(selector, labels) {
  const entries = Object.entries(record(selector));
  return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}

function isHeadlessService(service) {
  const spec = record(service.spec);
  return text(spec.clusterIP).toLowerCase() === 'none' || records(spec.clusterIPs).some((ip) => text(ip).toLowerCase() === 'none');
}

function validDnsLabel(value) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value);
}

/**
 * @typedef {{
 *   namespace: string,
 *   pod: string,
 *   status: string,
 *   dnsPolicy: string,
 *   hostname?: string,
 *   subdomain?: string,
 *   service?: string,
 *   shortName?: string,
 *   fqdn?: string,
 *   reason?: string
 * }} PodDnsSummary
 */

export function clusterDomainFromCoreDnsConfigMap(configMap) {
  const corefile = text(record(configMap).data?.Corefile);
  if (!corefile) return undefined;
  const match = corefile.match(/(?:^|\s)kubernetes\s+([^\s{]+)/m);
  const domain = match?.[1]?.trim().replace(/\.$/, '');
  return domain && domain !== '.' && domain.includes('.') ? domain : undefined;
}

/**
 * @param {{ pod: unknown, services: unknown[], clusterDomain?: string }} options
 * @returns {PodDnsSummary}
 */
export function buildPodDnsSummary({ pod, services, clusterDomain = undefined }) {
  const podRecord = record(pod);
  const podMeta = metadata(podRecord);
  const spec = record(podRecord.spec);
  const namespace = podMeta.namespace || 'default';
  const hostname = text(spec.hostname);
  const subdomain = text(spec.subdomain);
  const dnsPolicy = text(spec.dnsPolicy) || (spec.hostNetwork === true ? 'Default' : 'ClusterFirst');

  const base = {
    namespace,
    pod: podMeta.name,
    status: 'not-configured',
    dnsPolicy,
    ...(hostname ? { hostname } : {}),
    ...(subdomain ? { subdomain } : {})
  };

  if (!podMeta.name) {
    return { ...base, status: 'unavailable', reason: 'The Pod metadata is incomplete.' };
  }
  if (spec.hostNetwork === true || dnsPolicy === 'Default' || dnsPolicy === 'None') {
    return { ...base, reason: 'This Pod does not use Kubernetes-managed Pod DNS.' };
  }
  if (!hostname || !subdomain || !validDnsLabel(hostname) || !validDnsLabel(subdomain)) {
    return { ...base, reason: 'No explicit hostname and subdomain are configured for a stable Pod DNS record.' };
  }

  const service = records(services).find((candidate) => {
    const serviceMeta = metadata(candidate);
    const serviceSpec = record(candidate.spec);
    return serviceMeta.namespace === namespace && serviceMeta.name === subdomain && isHeadlessService(candidate) && selectorMatches(serviceSpec.selector, podMeta.labels);
  });

  if (!service) {
    return { ...base, reason: `No matching headless Service named ${subdomain} was found.` };
  }

  const publishNotReady = record(service.spec).publishNotReadyAddresses === true;
  if (!podReady(podRecord) && !publishNotReady) {
    return {
      ...base,
      status: 'not-currently-published',
      service: subdomain,
      reason: 'The matching headless Service does not publish DNS records for Not Ready Pods.'
    };
  }

  const shortName = `${hostname}.${subdomain}.${namespace}.svc`;
  return {
    ...base,
    status: 'verified',
    service: subdomain,
    shortName,
    ...(clusterDomain ? { fqdn: `${shortName}.${clusterDomain}` } : {}),
    reason: 'Configured through Pod hostname, subdomain, and a matching headless Service.'
  };
}
