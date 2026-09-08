const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const DIRECTIONS = ['ingress', 'egress'];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function ref(value, kind) {
  const metadata = record(value.metadata);
  return { kind, name: metadata.name, namespace: kind === 'Namespace' ? '' : metadata.namespace || 'default',
    ...(metadata.uid ? { uid: metadata.uid } : {}) };
}

function key(resource) {
  return [resource.namespace, resource.kind, resource.name, resource.uid || ''].map(encodeURIComponent).join('/');
}

function inventory(values, kind) {
  return [...new Map(records(values).filter((value) => typeof record(value.metadata).name === 'string' && value.metadata.name)
    .map((value) => [key(ref(value, kind)), value])).values()]
    .sort((a, b) => key(ref(a, kind)).localeCompare(key(ref(b, kind))));
}

function validSelector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.matchLabels != null && (typeof value.matchLabels !== 'object' || Array.isArray(value.matchLabels))) return false;
  if (Object.values(record(value.matchLabels)).some((label) => typeof label !== 'string')) return false;
  if (value.matchExpressions != null && !Array.isArray(value.matchExpressions)) return false;
  return (value.matchExpressions || []).every((raw) => {
    const expression = record(raw);
    if (typeof expression.key !== 'string' || !expression.key) return false;
    const values = expression.values ?? [];
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) return false;
    if (['In', 'NotIn'].includes(expression.operator)) return values.length > 0;
    return ['Exists', 'DoesNotExist'].includes(expression.operator) && values.length === 0;
  });
}

function emptySelector(value) {
  return validSelector(value) && Object.keys(record(value.matchLabels)).length === 0 && !(value.matchExpressions || []).length;
}

function matchesSelector(selector, labelsValue) {
  if (!validSelector(selector)) return false;
  const labels = record(labelsValue);
  if (!Object.entries(record(selector.matchLabels)).every(([name, value]) => Object.hasOwn(labels, name) && labels[name] === value)) return false;
  return (selector.matchExpressions || []).every(({ key: name, operator, values = [] }) => {
    const exists = Object.hasOwn(labels, name);
    if (operator === 'In') return exists && values.includes(labels[name]);
    if (operator === 'NotIn') return !exists || !values.includes(labels[name]);
    if (operator === 'Exists') return exists;
    return !exists;
  });
}

function policyDirections(spec) {
  const types = Array.isArray(spec.policyTypes) && spec.policyTypes.length
    ? spec.policyTypes : ['Ingress', ...(records(spec.egress).length ? ['Egress'] : [])];
  return DIRECTIONS.filter((direction) => types.includes(direction === 'ingress' ? 'Ingress' : 'Egress'));
}

function unrestrictedRule(rule, direction) {
  const peers = rule[direction === 'ingress' ? 'from' : 'to'];
  // A ports entry of {} still defaults to TCP, so it is not all protocols.
  if (rule.ports != null && (!Array.isArray(rule.ports) || rule.ports.length > 0)) return false;
  if (peers == null || (Array.isArray(peers) && peers.length === 0)) return true;
  return records(peers).some((peer) => Object.keys(peer).length === 0);
}

function selectorSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    ...(value.matchLabels != null ? { matchLabels: Object.fromEntries(Object.entries(record(value.matchLabels))
      .filter(([, label]) => typeof label === 'string').sort(([a], [b]) => a.localeCompare(b))) } : {}),
    ...(value.matchExpressions != null ? { matchExpressions: records(value.matchExpressions).map((expression) => ({
      key: typeof expression.key === 'string' ? expression.key : '',
      operator: typeof expression.operator === 'string' ? expression.operator : '',
      ...(Array.isArray(expression.values) ? { values: expression.values.filter((entry) => typeof entry === 'string') } : {})
    })) } : {})
  };
}

// Copy only NetworkPolicy fields needed for inspection. Never forward raw
// manifests, annotations or arbitrary extension fields to the drawer.
function ruleSummaries(value, peerField) {
  return records(value).map((rule) => ({
    ...(Array.isArray(rule.ports) ? { ports: records(rule.ports).map((port) => ({
      protocol: typeof port.protocol === 'string' ? port.protocol : 'TCP',
      ...(typeof port.port === 'string' || Number.isInteger(port.port) ? { port: port.port } : {}),
      ...(Number.isInteger(port.endPort) ? { endPort: port.endPort } : {})
    })) } : {}),
    ...(Array.isArray(rule[peerField]) ? { [peerField]: records(rule[peerField]).map((peer) => ({
      ...(peer.podSelector != null ? { podSelector: selectorSummary(peer.podSelector) } : {}),
      ...(peer.namespaceSelector != null ? { namespaceSelector: selectorSummary(peer.namespaceSelector) } : {}),
      ...(peer.ipBlock != null ? { ipBlock: {
        ...(typeof record(peer.ipBlock).cidr === 'string' ? { cidr: peer.ipBlock.cidr } : {}),
        ...(Array.isArray(record(peer.ipBlock).except) ? { except: peer.ipBlock.except.filter((cidr) => typeof cidr === 'string') } : {})
      } } : {})
    })) } : {})
  }));
}

/** Describes NetworkPolicy configuration only, never CNI enforcement or reachability. */
export function analyzeNetworkPosture({ pods = [], namespaces = [], networkPolicies = [] } = {}) {
  const allPods = inventory(pods, 'Pod');
  const activePods = allPods.filter((pod) => !['Succeeded', 'Failed'].includes(record(pod.status).phase));
  const policies = inventory(networkPolicies, 'NetworkPolicy');
  const namespaceInventory = inventory(namespaces, 'Namespace');
  const findings = [];
  const items = [];
  const selections = new Map(activePods.map((pod) => [key(ref(pod, 'Pod')), { ingress: [], egress: [] }]));
  function add(rule, resource, severity, title, message, evidence, recommendation) {
    findings.push({ id: `network:${rule}:${key(resource)}`, category: 'network', severity, title, message,
      resource: { ...resource }, evidence, recommendation,
      system: SYSTEM_NAMESPACES.has(resource.kind === 'Namespace' ? resource.name : resource.namespace) });
  }
  for (const policy of policies) {
    const resource = ref(policy, 'NetworkPolicy');
    const spec = record(policy.spec);
    const directions = policyDirections(spec);
    const selector = spec.podSelector;
    const selectedPods = activePods.filter((pod) => ref(pod, 'Pod').namespace === resource.namespace
      && matchesSelector(selector, record(pod.metadata).labels));
    const allowAll = { ingress: false, egress: false };
    const emptySelectors = [];
    if (emptySelector(selector)) emptySelectors.push('spec.podSelector selects every pod in this policy namespace; this is normal for default-deny policies');
    if (!validSelector(selector)) {
      add('invalid-selector', resource, 'info', 'Policy pod selector could not be evaluated',
        'The supplied pod selector is missing or invalid; no coverage is inferred from it.', ['spec.podSelector is not a valid label selector'],
        'Refresh the raw NetworkPolicy inventory and validate the selector against the Kubernetes API.');
    } else if (!selectedPods.length) {
      add('unmatched-selector', resource, 'info', 'Policy selects no observed active pods',
        'No supplied active pod matches this namespace-scoped selector; future pods may still match.',
        [`Namespace: ${resource.namespace}`, 'Matched active pods: 0'], 'Check labels and inventory completeness before changing the selector.');
    }
    for (const direction of directions) {
      const rules = records(spec[direction]);
      allowAll[direction] = rules.some((rule) => unrestrictedRule(rule, direction));
      if (allowAll[direction]) add(`allow-all-${direction}`, resource, 'warning', `Policy explicitly allows all ${direction}`,
        'An unrestricted rule adds allowance for all peers and ports in this direction. Other additive policies cannot narrow this allowance; CNI enforcement is unknown.',
        [`Direction: ${direction}`, `Selected active pods: ${selectedPods.length}`, 'At least one rule has no peer or port restrictions'],
        'Remove the unrestricted rule if unintended and allow only the required peers and ports.');
      const allAddresses = [];
      rules.forEach((rule, ruleIndex) => {
        const peerField = direction === 'ingress' ? 'from' : 'to';
        records(rule[peerField]).forEach((peer, peerIndex) => {
          for (const field of ['podSelector', 'namespaceSelector']) {
            if (emptySelector(peer[field])) emptySelectors.push(`spec.${direction}[${ruleIndex}].${peerField}[${peerIndex}].${field} is empty; peer selectors in the same entry are ANDed, and podSelector alone is namespace-local`);
          }
          const block = record(peer.ipBlock);
          if (['0.0.0.0/0', '::/0'].includes(block.cidr) && (block.except == null || (Array.isArray(block.except) && !block.except.length))) {
            allAddresses.push(`${block.cidr} allows all ${block.cidr === '::/0' ? 'IPv6' : 'IPv4'} addresses${Array.isArray(rule.ports) && rule.ports.length ? ' on the listed ports/protocols' : ' on all ports'} in spec.${direction}[${ruleIndex}]`);
          }
        });
      });
      if (allAddresses.length) add(`allow-all-addresses-${direction}`, resource, 'warning', `Policy allows all addresses in an IP family for ${direction}`,
        'An explicit /0 peer has no exclusions. Its allowance is limited by IP family and any port restrictions; this is not a CNI enforcement verdict.',
        allAddresses, 'Use narrower CIDRs or peer selectors if unrestricted address-family access is not intended.');
      for (const pod of selectedPods) selections.get(key(ref(pod, 'Pod')))[direction].push({ resource, allowAll: allowAll[direction] });
    }
    items.push({ id: `network:policy:${key(resource)}`, type: 'policy', resource, system: SYSTEM_NAMESPACES.has(resource.namespace),
      provider: 'Kubernetes', kind: resource.kind, name: resource.name, namespace: resource.namespace,
      mode: 'Configuration only', ruleCount: records(spec.ingress).length + records(spec.egress).length,
      summary: `Selects ${selectedPods.length} observed active pod(s) for ${directions.join(', ') || 'no recognized direction'}. CNI enforcement is unknown.`,
      directions, selectedPods: selectedPods.map((pod) => ref(pod, 'Pod')), allowAll, selectorValid: validSelector(selector),
      configuration: { podSelector: selectorSummary(selector),
        policyTypes: directions.map((direction) => direction === 'ingress' ? 'Ingress' : 'Egress'),
        policyTypesDefaulted: !Array.isArray(spec.policyTypes) || !spec.policyTypes.length,
        ingress: ruleSummaries(spec.ingress, 'from'), egress: ruleSummaries(spec.egress, 'to'), emptySelectors }
    });
  }

  for (const pod of activePods) {
    const resource = ref(pod, 'Pod');
    const selected = selections.get(key(resource));
    const coverage = Object.fromEntries(DIRECTIONS.map((direction) => [direction, {
      covered: selected[direction].length > 0,
      allowAll: selected[direction].some((policy) => policy.allowAll),
      policies: selected[direction].map((policy) => ({ ...policy.resource }))
    }]));
    const missing = DIRECTIONS.filter((direction) => !coverage[direction].covered);
    if (missing.length) add('missing-coverage', resource, 'info', 'Pod lacks directional NetworkPolicy coverage',
      'No supplied NetworkPolicy selects this pod for the listed directions. Inventory may be incomplete; enforcement and actual reachability are unknown.',
      missing.map((direction) => `No selecting ${direction} policy`),
      'Review namespace isolation requirements and inventory completeness; add selecting policies and required allow rules where appropriate.');
    const hostNetwork = record(pod.spec).hostNetwork === true;
    if (hostNetwork) add('host-network', resource, 'info', 'Host-network policy behavior is implementation-dependent',
      'This pod shares the host network. Selector matches do not establish that a CNI applies NetworkPolicy to its traffic.',
      ['spec.hostNetwork=true'], 'Verify host-network handling with the deployed network plugin and test actual traffic.');
    items.push({ id: `network:pod:${key(resource)}`, type: 'pod', resource, system: SYSTEM_NAMESPACES.has(resource.namespace), hostNetwork,
      ingress: coverage.ingress, egress: coverage.egress });
  }
  for (const namespace of namespaceInventory) {
    const resource = ref(namespace, 'Namespace');
    if (!policies.some((policy) => ref(policy, 'NetworkPolicy').namespace === resource.name)
      && !activePods.some((pod) => ref(pod, 'Pod').namespace === resource.name)) {
      add('missing-coverage', resource, 'info', 'Namespace has no observed NetworkPolicies',
        'No NetworkPolicy or active pod was supplied for this namespace; this is an inventory observation, not an exposure or enforcement verdict.',
        ['Observed NetworkPolicies: 0', 'Observed active pods: 0'], 'Review network isolation requirements before deploying workloads here.');
    }
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  items.sort((a, b) => key(a.resource).localeCompare(key(b.resource)));
  const podItems = items.filter((item) => item.type === 'pod');
  const namespaceNames = new Set([...namespaceInventory.map((namespace) => namespace.metadata.name),
    ...items.map((item) => item.resource.namespace)]);
  return { findings, coverage: {
    totalPods: activePods.length, totalPolicies: policies.length, namespaces: namespaceNames.size,
    ingressCoveredPods: podItems.filter((item) => item.ingress.covered).length,
    egressCoveredPods: podItems.filter((item) => item.egress.covered).length,
    bothCoveredPods: podItems.filter((item) => item.ingress.covered && item.egress.covered).length,
    uncoveredPods: podItems.filter((item) => !item.ingress.covered || !item.egress.covered).length,
    excludedCompletedPods: allPods.length - activePods.length, enforcement: 'unknown',
    notes: ['Coverage means selection by a supplied policy for a direction, not effective restriction or verified CNI enforcement.',
      'Policies are additive. This analysis does not simulate peer reachability, named ports, NAT, plugin-specific policies or non-L4 traffic.',
      'An empty input array cannot distinguish an empty inventory from unavailable or permission-denied data.']
  }, items };
}
