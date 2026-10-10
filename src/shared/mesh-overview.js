// Istio overview for the Service Mesh page: control plane, coverage, findings, routes, policies and registry.
// Shared by the agent and the browser-direct runtime; input is raw Kubernetes/Istio objects, output is display-ready.
import { parse } from 'yaml';

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');
const meta = (object) => record(object?.metadata);
const labelsOf = (object) => record(meta(object).labels);
const ROOT_NAMESPACE = 'istio-system';

function imageTag(image) {
  const match = /:([^:@/]+)(?:@.*)?$/.exec(text(image));
  return match ? match[1].replace(/-distroless$/, '') : '';
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/).map((part) => Number(part) || 0);
  const b = right.split(/[.-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function selectorMatches(selector, labels) {
  const entries = Object.entries(record(selector));
  return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}

/** "api.kubi-saas.svc.cluster.local" → "api"; external hosts stay as written. */
const shortHost = (host) => (/\.svc(\.|$)/.test(text(host)) ? text(host).split('.')[0] : text(host));

function sidecarOf(pod) {
  return list(record(pod.spec).containers).find((container) => text(record(container).name) === 'istio-proxy')
    || list(record(pod.spec).initContainers).find((container) => text(record(container).name) === 'istio-proxy' && record(container).restartPolicy === 'Always');
}

function workloadName(pod) {
  const owner = list(meta(pod).ownerReferences).find((entry) => record(entry).controller) || list(meta(pod).ownerReferences)[0];
  const name = text(record(owner).name) || text(meta(pod).name);
  return text(record(owner).kind) === 'ReplicaSet' ? name.replace(/-[a-z0-9]{5,10}$/, '') : name;
}

function componentFrom(workloads, pattern, kind) {
  const workload = workloads.find((item) => pattern.test(text(meta(item).name)));
  if (!workload) return undefined;
  const status = record(workload.status);
  const ready = kind === 'DaemonSet' ? Number(status.numberReady) || 0 : Number(status.readyReplicas) || 0;
  const desired = kind === 'DaemonSet' ? Number(status.desiredNumberScheduled) || 0 : Number(record(workload.spec).replicas ?? 1) || 0;
  const image = text(record(list(record(record(record(workload.spec).template).spec).containers)[0]).image);
  return { namespace: text(meta(workload).namespace), ready, desired, version: imageTag(image), state: desired > 0 && ready >= desired ? 'ready' : ready > 0 ? 'degraded' : 'down' };
}

/** Human description of one HTTP route match, e.g. "header x-canary = true" or "prefix /ws". */
export function describeMatch(match) {
  const source = record(match);
  const uri = record(source.uri);
  if (uri.prefix !== undefined) return `prefix ${uri.prefix}`;
  if (uri.exact !== undefined) return `exact ${uri.exact}`;
  if (uri.regex !== undefined) return `regex ${uri.regex}`;
  const [header, condition] = Object.entries(record(source.headers))[0] ?? [];
  if (header) {
    const value = record(condition);
    return `header ${header} = ${value.exact ?? value.prefix ?? value.regex ?? '*'}`;
  }
  const authority = record(source.authority);
  if (authority.exact ?? authority.prefix) return `host ${authority.exact ?? authority.prefix}`;
  if (record(source.method).exact) return `method ${record(source.method).exact}`;
  return 'prefix /';
}

function resilienceOf(rule) {
  const items = [];
  const source = record(rule);
  if (source.redirect) items.push(String(record(source.redirect).redirectCode ?? 301));
  if (source.timeout) items.push(`timeout ${source.timeout}`);
  const retries = record(source.retries);
  if (retries.attempts !== undefined) items.push(`retries ${retries.attempts}${retries.retryOn ? ` · ${String(retries.retryOn).replace(/gateway-error,?|connect-failure,?|refused-stream,?/g, '').replace(/,$/, '') || retries.retryOn}` : ''}`);
  const fault = record(source.fault);
  const delay = record(fault.delay);
  if (delay.fixedDelay) items.push(`fault: delay ${delay.fixedDelay} · ${record(delay.percentage).value ?? delay.percent ?? 100}%`);
  const abort = record(fault.abort);
  if (abort.httpStatus) items.push(`fault: abort ${abort.httpStatus} · ${record(abort.percentage).value ?? 100}%`);
  if (source.mirror) items.push(`mirror → ${shortHost(record(source.mirror).host)} ${record(source.mirrorPercentage).value ?? 100}%`);
  return items;
}

function buildRoutes(virtualServices) {
  return virtualServices.map((vs) => {
    const spec = record(vs.spec);
    const namespace = text(meta(vs).namespace);
    const rules = list(spec.http).flatMap((rule) => {
      const source = record(rule);
      const matches = list(source.match).length ? list(source.match) : [{}];
      const destinations = source.redirect
        ? [{ label: `redirect → ${text(record(source.redirect).authority) || text(record(source.redirect).uri) || 'location'}`, weight: 100 }]
        : list(source.route).map((entry, index, all) => {
            const destination = record(record(entry).destination);
            const host = shortHost(destination.host);
            return { label: `${host}${destination.subset ? `:${destination.subset}` : ''}`, weight: Number(record(entry).weight) || (all.length === 1 ? 100 : 0), host: text(destination.host), subset: text(destination.subset) || undefined };
          });
      return matches.slice(0, 1).map((match) => ({ match: describeMatch(match), destinations, resilience: resilienceOf(source) }));
    });
    for (const kind of ['tcp', 'tls']) {
      for (const rule of list(spec[kind])) {
        rules.push({
          match: kind.toUpperCase(),
          destinations: list(record(rule).route).map((entry) => ({ label: shortHost(record(record(entry).destination).host), weight: Number(record(entry).weight) || 100 })),
          resilience: []
        });
      }
    }
    const gateways = list(spec.gateways).map((gateway) => (text(gateway).includes('/') ? text(gateway) : gateway === 'mesh' ? 'mesh' : `${namespace}/${gateway}`));
    return {
      namespace,
      name: text(meta(vs).name),
      hosts: list(spec.hosts).map(text),
      gateways: gateways.length ? gateways : ['mesh'],
      rules,
      resilience: [...new Set(rules.flatMap((rule) => rule.resilience))]
    };
  }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function principalText(principal) {
  const match = /cluster\.local\/ns\/([^/]+)\/sa\/(.+)$/.exec(text(principal));
  return match ? `sa ${match[1]}/${match[2]}` : text(principal);
}

function authorizationDetails(spec) {
  const details = [];
  for (const rule of list(spec.rules)) {
    for (const from of list(record(rule).from)) {
      const source = record(record(from).source);
      if (list(source.principals).length) details.push(`from ${list(source.principals).map(principalText).join(', ')}`);
      if (list(source.namespaces).length) details.push(`from ns ${list(source.namespaces).join(', ')}`);
      if (list(source.ipBlocks).length) details.push(`from ipBlocks ${list(source.ipBlocks).join(', ')}`);
      if (list(source.requestPrincipals).length) details.push(`from JWT ${list(source.requestPrincipals).join(', ')}`);
    }
    for (const to of list(record(rule).to)) {
      const operation = record(record(to).operation);
      const parts = [list(operation.methods).join('|'), list(operation.paths).join(', '), list(operation.ports).map((port) => `:${port}`).join(', ')].filter(Boolean);
      if (parts.length) details.push(`to ${parts.join(' ')}`);
    }
  }
  return details;
}

function appliesTo(object, fallback) {
  const selector = record(record(record(object.spec).selector).matchLabels);
  const entries = Object.entries(selector);
  if (entries.length) return entries.map(([key, value]) => `${key}=${value}`).join(', ');
  return fallback;
}

function buildPolicies({ peerAuthentications, authorizationPolicies, requestAuthentications, destinationRules }) {
  const items = [];
  for (const pa of peerAuthentications) {
    const spec = record(pa.spec);
    const namespace = text(meta(pa).namespace);
    const meshWide = namespace === ROOT_NAMESPACE && !Object.keys(record(record(spec.selector).matchLabels)).length;
    const mode = text(record(spec.mtls).mode) || 'UNSET';
    const ports = Object.entries(record(spec.portLevelMtls));
    const details = mode === 'STRICT'
      ? [meshWide ? 'all workloads require mTLS' : 'plaintext is rejected']
      : mode === 'PERMISSIVE'
        ? [`plaintext still accepted${ports.length ? ` on ${ports.map(([port]) => `:${port}`).join(', ')}` : ''}`]
        : mode === 'DISABLE' ? ['mTLS disabled'] : ['inherits the parent policy'];
    items.push({ kind: 'PeerAuthentication', category: 'mtls', namespace, name: text(meta(pa).name), appliesTo: meshWide ? 'mesh-wide' : appliesTo(pa, `namespace ${namespace}`), effect: mode, tone: mode === 'STRICT' ? 'ok' : mode === 'PERMISSIVE' ? 'warn' : 'crit', details });
  }
  for (const policy of authorizationPolicies) {
    const spec = record(policy.spec);
    const namespace = text(meta(policy).namespace);
    const action = text(spec.action) || 'ALLOW';
    const allowNothing = action === 'ALLOW' && list(spec.rules).length === 0;
    const details = allowNothing ? ['everything not explicitly allowed'] : authorizationDetails(spec);
    items.push({
      kind: 'AuthorizationPolicy', category: 'authorization', namespace, name: text(meta(policy).name), appliesTo: appliesTo(policy, `namespace ${namespace}`),
      effect: allowNothing ? 'DENY' : action, tone: allowNothing || action === 'DENY' ? 'crit' : action === 'ALLOW' ? 'ok' : undefined,
      details: details.length ? details : action === 'DENY' ? ['matching requests are denied'] : ['all requests match']
    });
  }
  for (const policy of requestAuthentications) {
    const namespace = text(meta(policy).namespace);
    const rules = list(record(policy.spec).jwtRules);
    items.push({
      kind: 'RequestAuthentication', category: 'jwt', namespace, name: text(meta(policy).name), appliesTo: appliesTo(policy, `namespace ${namespace}`), effect: 'JWT',
      details: rules.flatMap((rule) => [`issuer ${text(record(rule).issuer)}`, record(rule).jwksUri ? `jwks ${text(record(rule).jwksUri)}` : ''].filter(Boolean))
    });
  }
  for (const rule of destinationRules) {
    const spec = record(rule.spec);
    const policy = record(spec.trafficPolicy);
    const outlier = record(policy.outlierDetection);
    const pool = record(record(policy.connectionPool).tcp);
    const details = [
      list(spec.subsets).length ? `subsets ${list(spec.subsets).map((subset) => text(record(subset).name)).join(', ')}` : '',
      outlier.consecutive5xxErrors ?? outlier.consecutiveErrors ? `outlierDetection ${outlier.consecutive5xxErrors ?? outlier.consecutiveErrors}×5xx → eject ${outlier.baseEjectionTime ?? '30s'}` : '',
      pool.maxConnections ? `connectionPool maxConn ${pool.maxConnections}` : '',
      text(record(policy.tls).mode)
    ].filter(Boolean);
    items.push({ kind: 'DestinationRule', category: 'destinationrule', namespace: text(meta(rule).namespace), name: text(meta(rule).name), appliesTo: `host ${shortHost(spec.host)}`, effect: 'TRAFFIC', details: details.length ? details : ['default traffic policy'] });
  }
  const order = { mtls: 0, authorization: 1, jwt: 2, destinationrule: 3 };
  return items.sort((a, b) => order[a.category] - order[b.category] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function meshConfigOf(configMaps) {
  const config = configMaps.find((item) => text(meta(item).name) === 'istio' && text(meta(item).namespace) === ROOT_NAMESPACE);
  try {
    return record(parse(text(record(config?.data).mesh)) ?? {});
  } catch {
    return {};
  }
}

// Injected namespaces first, then namespaces outside the mesh, then the control plane.
const coverageRank = (row) => (row.injection === 'control plane' ? 2 : row.injection === 'disabled' ? 1 : 0);

/** Builds the Istio overview; returns undefined when no Istio control plane or CRDs are visible. */
export function buildMeshOverview(input) {
  const pods = list(input.pods);
  const deployments = list(input.deployments);
  const daemonSets = list(input.daemonSets);
  const istiod = componentFrom(deployments, /^istiod(-|$)/, 'Deployment');
  const istioObjects = ['virtualServices', 'destinationRules', 'gateways', 'serviceEntries', 'peerAuthentications', 'authorizationPolicies', 'requestAuthentications'].some((key) => list(input[key]).length);
  if (!istiod && !istioObjects && !pods.some(sidecarOf)) return undefined;

  const ingress = componentFrom(deployments, /istio-ingressgateway|ingress-gateway/, 'Deployment');
  const egress = componentFrom(deployments, /istio-egressgateway|egress-gateway/, 'Deployment');
  const cni = componentFrom(daemonSets, /^istio-cni/, 'DaemonSet');
  const ztunnel = componentFrom(daemonSets, /^ztunnel$/, 'DaemonSet');
  const lb = list(input.services).find((service) => text(record(service.spec).type) === 'LoadBalancer' && /ingressgateway|ingress-gateway/.test(text(meta(service).name)));
  const lbAddress = text(record(list(record(record(lb?.status).loadBalancer).ingress)[0]).ip) || text(record(list(record(record(lb?.status).loadBalancer).ingress)[0]).hostname);
  const components = [
    { name: 'istiod', ...(istiod ?? { state: 'not installed' }), detail: istiod ? `${istiod.namespace} · ${istiod.ready}/${istiod.desired} · ${istiod.version}` : 'control plane not found' },
    { name: 'istio-ingressgateway', ...(ingress ?? { state: 'not installed' }), detail: ingress ? `${ingress.namespace} · ${ingress.ready}/${ingress.desired}${lbAddress ? ` · LB ${lbAddress}` : ''}` : 'no ingress gateway' },
    { name: 'istio-egressgateway', ...(egress ?? { state: 'not installed' }), detail: egress ? `${egress.namespace} · ${egress.ready}/${egress.desired}` : 'egress goes direct from sidecars' },
    ztunnel
      ? { name: 'ztunnel', ...ztunnel, detail: `DaemonSet · ${ztunnel.ready}/${ztunnel.desired} nodes` }
      : { name: 'istio-cni', ...(cni ?? { state: 'not installed' }), detail: cni ? `DaemonSet · ${cni.ready}/${cni.desired} nodes` : 'init containers set up traffic redirection' }
  ];

  const peerAuthentications = list(input.peerAuthentications);
  const rootPolicy = peerAuthentications.find((pa) => text(meta(pa).namespace) === ROOT_NAMESPACE && !Object.keys(record(record(record(pa.spec).selector).matchLabels)).length);
  const meshMtls = text(record(record(rootPolicy?.spec).mtls).mode) || 'PERMISSIVE';
  const nsMtls = new Map(peerAuthentications
    .filter((pa) => !Object.keys(record(record(record(pa.spec).selector).matchLabels)).length && text(meta(pa).namespace) !== ROOT_NAMESPACE)
    .map((pa) => [text(meta(pa).namespace), text(record(record(pa.spec).mtls).mode) || meshMtls]));

  const running = pods.filter((pod) => !['Succeeded', 'Failed'].includes(text(record(pod.status).phase)));
  const proxyVersions = new Map();
  const coverage = list(input.namespaces).map((namespace) => {
    const name = text(meta(namespace).name);
    const labels = labelsOf(namespace);
    const nsPods = running.filter((pod) => text(meta(pod).namespace) === name && !labelsOf(pod)['job-name']);
    const injected = nsPods.filter(sidecarOf);
    for (const pod of injected) {
      const version = imageTag(record(sidecarOf(pod)).image);
      if (version) proxyVersions.set(`${name}/${version}`, (proxyVersions.get(`${name}/${version}`) ?? 0) + 1);
    }
    const injection = name === ROOT_NAMESPACE || name === istiod?.namespace
      ? 'control plane'
      : labels['istio-injection'] === 'enabled' ? 'istio-injection=enabled'
        : labels['istio.io/rev'] ? `istio.io/rev=${labels['istio.io/rev']}`
          : labels['istio.io/dataplane-mode'] === 'ambient' ? 'ambient' : 'disabled';
    const enabled = injection !== 'disabled' && injection !== 'control plane';
    const missing = enabled ? nsPods.filter((pod) => !sidecarOf(pod)) : [];
    return {
      namespace: name, injection, injected: injected.length, total: nsPods.length,
      mtls: injected.length || enabled ? nsMtls.get(name) ?? meshMtls : undefined,
      missing: [...new Set(missing.map(workloadName))]
    };
  }).filter((row) => row.total > 0 || row.injection !== 'disabled');

  const findings = [];
  const destinationRules = list(input.destinationRules);
  const services = list(input.services);
  for (const route of buildRoutes(list(input.virtualServices))) {
    for (const rule of route.rules) {
      for (const destination of rule.destinations) {
        if (!destination.subset || !destination.host) continue;
        const dr = destinationRules.find((item) => shortHost(record(item.spec).host) === shortHost(destination.host));
        const subset = list(record(dr?.spec).subsets).find((entry) => text(record(entry).name) === destination.subset);
        const service = services.find((item) => text(meta(item).name) === shortHost(destination.host) && text(meta(item).namespace) === route.namespace);
        const selector = { ...record(record(service?.spec).selector), ...record(record(subset).labels) };
        const matched = running.some((pod) => text(meta(pod).namespace) === route.namespace && selectorMatches(selector, labelsOf(pod)));
        if (!subset || !matched) {
          findings.push({
            severity: 'error',
            title: subset ? `${destination.subset[0].toUpperCase()}${destination.subset.slice(1)} subset has no pods` : `Subset ${destination.subset} is not defined`,
            object: `${route.namespace}/${route.name} · subset ${destination.subset}${subset ? ` (${Object.entries(record(record(subset).labels)).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
            message: `${destination.weight}% of requests return 503. Scale the ${destination.subset} pods or set its weight to 0.`
          });
        }
      }
      for (const item of rule.resilience.filter((entry) => entry.startsWith('fault:'))) {
        findings.push({ severity: 'info', title: `Fault injection in ${route.namespace}`, object: `${route.namespace}/${route.name} · ${item.slice(7)}`, message: 'Intentional chaos test, or forgotten?' });
      }
    }
  }
  for (const row of coverage) {
    if (row.missing.length) {
      findings.push({
        severity: 'warning', title: 'Injection enabled but pods lack sidecars',
        object: `${row.namespace} · ${row.total - row.injected} of ${row.total} pods started before the label was set`,
        message: `Restart ${row.missing.slice(0, 3).join(' and ')} to join the mesh.`
      });
    }
  }
  for (const pa of peerAuthentications) {
    if (text(record(record(pa.spec).mtls).mode) !== 'PERMISSIVE') continue;
    const ports = Object.keys(record(record(pa.spec).portLevelMtls));
    findings.push({
      severity: 'warning', title: 'mTLS is PERMISSIVE', object: `${text(meta(pa).namespace)}/${text(meta(pa).name)}`,
      message: `Plaintext is still accepted${ports.length ? ` on ${ports.map((port) => `:${port}`).join(', ')}` : ''} — switch to STRICT once all clients have sidecars.`
    });
  }
  if (istiod?.version) {
    for (const [key, count] of proxyVersions) {
      const [namespace, version] = key.split('/');
      if (compareVersions(version, istiod.version) < 0) {
        findings.push({ severity: 'warning', title: 'Proxy older than control plane', object: `${namespace} · ${count} sidecars on ${version}, istiod ${istiod.version}`, message: 'Rolling restart picks up the new proxy.' });
      }
    }
  }
  const severityOrder = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const meshConfig = meshConfigOf(list(input.configMaps));
  const outboundPolicy = text(record(meshConfig.outboundTrafficPolicy).mode) || 'ALLOW_ANY';
  const routes = buildRoutes(list(input.virtualServices));
  const registry = list(input.serviceEntries).map((entry) => {
    const spec = record(entry.spec);
    const hosts = list(spec.hosts).map(text);
    const usedBy = [
      ...routes.filter((route) => route.rules.some((rule) => rule.destinations.some((destination) => hosts.includes(text(destination.host))))).map((route) => `${route.namespace}/${route.name}`),
      ...destinationRules.filter((rule) => hosts.includes(text(record(rule.spec).host))).map((rule) => `${text(meta(rule).namespace)}/${text(meta(rule).name)}`)
    ];
    return {
      namespace: text(meta(entry).namespace), name: text(meta(entry).name), hosts: hosts.length ? hosts : list(spec.addresses).map(text),
      ports: list(spec.ports).map((port) => `${record(port).number}/${record(port).protocol ?? 'TCP'}`),
      location: text(spec.location) || 'MESH_EXTERNAL', resolution: text(spec.resolution) || 'NONE', usedBy: [...new Set(usedBy)]
    };
  });

  const versions = [...proxyVersions.keys()].map((key) => key.split('/')[1]);
  return {
    provider: {
      name: 'Istio',
      version: istiod?.version || versions[0] || '',
      mode: ztunnel || coverage.some((row) => row.injection === 'ambient') ? 'ambient' : 'sidecar',
      istiod: istiod ? `${istiod.ready}/${istiod.desired}` : undefined,
      meshMtls,
      podsInMesh: coverage.reduce((sum, row) => sum + row.injected, 0),
      podsTotal: coverage.reduce((sum, row) => sum + row.total, 0)
    },
    components,
    coverage: coverage.map(({ missing, ...row }) => row).sort((a, b) => coverageRank(a) - coverageRank(b) || a.namespace.localeCompare(b.namespace)),
    findings,
    routes: routes.map((route) => ({ ...route, rules: route.rules.map(({ resilience, ...rule }) => ({ ...rule, destinations: rule.destinations.map(({ label, weight }) => ({ label, weight })) })) })),
    policies: buildPolicies({ peerAuthentications, authorizationPolicies: list(input.authorizationPolicies), requestAuthentications: list(input.requestAuthentications), destinationRules }),
    registry: { outboundPolicy, entries: registry }
  };
}
