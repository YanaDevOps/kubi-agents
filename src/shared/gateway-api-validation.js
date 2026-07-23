const SUPPORTED_GATEWAY_KINDS = new Set([
  'GatewayClass',
  'Gateway',
  'HTTPRoute',
  'GRPCRoute',
  'TLSRoute',
  'TCPRoute',
  'UDPRoute',
  'ReferenceGrant'
]);

const ROUTE_KINDS = new Set(['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute']);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function metadata(value) {
  const meta = record(record(value).metadata);
  return {
    name: text(meta.name),
    namespace: text(meta.namespace),
    generation: Number(meta.generation || 0)
  };
}

function conditions(value) {
  return records(value).map((condition) => ({
    type: text(condition.type),
    status: text(condition.status) || 'Unknown',
    reason: text(condition.reason),
    message: text(condition.message),
    observedGeneration: Number(condition.observedGeneration || 0)
  }));
}

function finding(id, severity, title, message, nextStep, objectRefs, evidence = []) {
  return {
    id,
    category: 'networking',
    severity,
    title,
    message,
    nextStep,
    objectRefs,
    evidence
  };
}

function conditionEvidence(condition) {
  return [
    `${condition.type}=${condition.status}`,
    condition.reason ? `Reason ${condition.reason}` : '',
    condition.message
  ].filter(Boolean);
}

function positiveConditionFindings(kind, item, sourceConditions, prefix) {
  const meta = metadata(item);
  const refs = [{ kind, namespace: meta.namespace || undefined, name: meta.name }];
  const result = [];
  for (const condition of sourceConditions) {
    if (!['Accepted', 'Programmed', 'ResolvedRefs'].includes(condition.type) || condition.status === 'True') continue;
    const unknown = condition.status === 'Unknown';
    result.push(
      finding(
        `${prefix}.${condition.type.toLowerCase()}.${meta.namespace || '_'}.${meta.name}`,
        unknown ? 'warning' : condition.type === 'Accepted' && kind === 'GatewayClass' ? 'warning' : 'critical',
        `${kind} ${condition.type} is ${condition.status}`,
        condition.message || `${kind} ${meta.namespace ? `${meta.namespace}/` : ''}${meta.name} reports ${condition.type}=${condition.status}.`,
        unknown
          ? 'Wait for the owning controller to reconcile this resource, then review its status again.'
          : 'Review the controller status reason and correct the rejected or unresolved configuration.',
        refs,
        conditionEvidence(condition)
      )
    );
  }
  return result;
}

function statusIsStale(item, sourceConditions) {
  const generation = metadata(item).generation;
  if (!generation) return false;
  return sourceConditions.some((condition) => condition.observedGeneration > 0 && condition.observedGeneration < generation);
}

function routeParentStatuses(route) {
  return records(record(record(route).status).parents);
}

function routeBackendRefs(route) {
  return records(record(record(route).spec).rules).flatMap((rule) => records(record(rule).backendRefs));
}

function routeParentRefs(route) {
  return records(record(record(route).spec).parentRefs);
}

function serviceKey(namespace, name) {
  return `${namespace}/${name}`;
}

function servicePortMatches(service, requestedPort) {
  if (requestedPort === undefined || requestedPort === null || requestedPort === '') return true;
  const ports = records(service.ports);
  return ports.some((port) => Number(port.port) === Number(requestedPort) || text(port.name) === String(requestedPort));
}

function referenceGrantAllows(referenceGrants, routeKind, routeNamespace, targetNamespace, backendRef) {
  if (routeNamespace === targetNamespace) return true;
  return referenceGrants.some((grant) => {
    const meta = metadata(grant);
    if (meta.namespace !== targetNamespace) return false;
    const spec = record(record(grant).spec);
    const fromMatches = records(spec.from).some((from) =>
      text(from.group) === 'gateway.networking.k8s.io' &&
      text(from.kind) === routeKind &&
      text(from.namespace) === routeNamespace
    );
    const toMatches = records(spec.to).some((to) => {
      const group = text(to.group);
      const kind = text(to.kind) || 'Service';
      const name = text(to.name);
      return (group === '' || group === 'core') && kind === 'Service' && (!name || name === text(backendRef.name));
    });
    return fromMatches && toMatches;
  });
}

function endpointStateForService(service, portRows, requestedPort) {
  const namespace = metadata(service).namespace || text(service.namespace);
  const name = metadata(service).name || text(service.name);
  const matchingRows = portRows.filter((row) => {
    if (text(row.namespace) !== namespace || text(row.service) !== name) return false;
    if (requestedPort === undefined || requestedPort === null || requestedPort === '') return true;
    return Number(row.port) === Number(requestedPort) || text(row.portName) === String(requestedPort);
  });
  if (matchingRows.length > 0) {
    const ready = Math.min(...matchingRows.map((row) => Number(row.readyEndpoints || 0)));
    const total = Math.max(...matchingRows.map((row) => Number(row.totalEndpoints || 0)));
    return { ready, total, known: true };
  }
  const availability = record(service.endpointAvailability);
  if (availability.status) {
    return {
      ready: Number(availability.readyAddresses || 0),
      total: Number(availability.addresses || 0),
      known: true
    };
  }
  return { ready: 0, total: 0, known: false };
}

export function gatewayApiDefinitionsFromCrds(crds) {
  return records(crds).flatMap((crd) => {
    const spec = record(crd.spec);
    const names = record(spec.names);
    const kind = text(names.kind);
    if (text(spec.group) !== 'gateway.networking.k8s.io' || !SUPPORTED_GATEWAY_KINDS.has(kind)) return [];
    const version = records(spec.versions).find((entry) => entry.served === true)?.name;
    if (!version) return [];
    return [{
      name: metadata(crd).name,
      group: text(spec.group),
      version: text(version),
      plural: text(names.plural),
      kind,
      scope: text(spec.scope)
    }];
  });
}

export function buildGatewayApiValidationItems(input) {
  const gatewayClasses = records(input.gatewayClasses);
  const gateways = records(input.gateways);
  const routes = records(input.routes);
  const referenceGrants = records(input.referenceGrants);
  const services = records(input.services);
  const portRows = records(input.portRows);
  const namespaceScope = text(input.namespaceScope);
  const servicesPartial = input.servicesPartial === true;
  const grantsPartial = input.referenceGrantsPartial === true;
  const items = [];

  for (const gatewayClass of gatewayClasses) {
    const sourceConditions = conditions(record(gatewayClass.status).conditions);
    items.push(...positiveConditionFindings('GatewayClass', gatewayClass, sourceConditions, 'networking.gatewayclass'));
    if (statusIsStale(gatewayClass, sourceConditions)) {
      const meta = metadata(gatewayClass);
      items.push(finding(
        `networking.gatewayclass.stale.${meta.name}`,
        'warning',
        'GatewayClass status is stale',
        `${meta.name} has not reconciled its current generation.`,
        'Check the Gateway API controller and wait for status.observedGeneration to catch up.',
        [{ kind: 'GatewayClass', name: meta.name }]
      ));
    }
  }

  for (const gateway of gateways) {
    const meta = metadata(gateway);
    if (namespaceScope && namespaceScope !== 'all' && meta.namespace !== namespaceScope) continue;
    const gatewayConditions = conditions(record(gateway.status).conditions);
    const listenerConditions = records(record(gateway.status).listeners).flatMap((listener) => conditions(listener.conditions));
    items.push(...positiveConditionFindings('Gateway', gateway, [...gatewayConditions, ...listenerConditions], 'networking.gateway'));
    if (statusIsStale(gateway, [...gatewayConditions, ...listenerConditions])) {
      items.push(finding(
        `networking.gateway.stale.${meta.namespace}.${meta.name}`,
        'warning',
        'Gateway status is stale',
        `${meta.namespace}/${meta.name} has not reconciled its current generation.`,
        'Check the Gateway controller and its events.',
        [{ kind: 'Gateway', namespace: meta.namespace, name: meta.name }]
      ));
    }
  }

  const gatewayKeys = new Set(gateways.map((gateway) => {
    const meta = metadata(gateway);
    return serviceKey(meta.namespace, meta.name);
  }));
  const serviceMap = new Map(services.map((service) => {
    const meta = metadata(service);
    return [serviceKey(meta.namespace || text(service.namespace), meta.name || text(service.name)), service];
  }));

  for (const route of routes) {
    const meta = metadata(route);
    const kind = text(route.kind);
    if (!ROUTE_KINDS.has(kind)) continue;
    if (namespaceScope && namespaceScope !== 'all' && meta.namespace !== namespaceScope) continue;
    const routeRef = { kind, namespace: meta.namespace, name: meta.name };
    const parentStatuses = routeParentStatuses(route);
    const parentConditions = parentStatuses.flatMap((parent) => conditions(parent.conditions));
    parentStatuses.forEach((parent, index) => {
      const parentRef = record(parent.parentRef);
      const parentKey = `${text(parentRef.namespace) || meta.namespace}.${text(parentRef.name) || index}`;
      items.push(...positiveConditionFindings(
        kind,
        route,
        conditions(parent.conditions),
        `networking.${kind.toLowerCase()}.${parentKey}`
      ));
    });

    if (routeParentRefs(route).length > 0 && parentStatuses.length === 0) {
      items.push(finding(
        `networking.route.no_parent_status.${kind}.${meta.namespace}.${meta.name}`,
        'warning',
        `${kind} has no parent status`,
        `${meta.namespace}/${meta.name} references a parent, but no controller has reported attachment status.`,
        'Verify the referenced Gateway, allowedRoutes policy, and Gateway controller.',
        [routeRef]
      ));
    }

    for (const parentRef of routeParentRefs(route)) {
      const parentKind = text(parentRef.kind) || 'Gateway';
      if (parentKind !== 'Gateway') continue;
      const parentNamespace = text(parentRef.namespace) || meta.namespace;
      if (input.partial !== true &&
          (!namespaceScope || namespaceScope === 'all' || parentNamespace === namespaceScope) &&
          !gatewayKeys.has(serviceKey(parentNamespace, text(parentRef.name)))) {
        items.push(finding(
          `networking.route.missing_parent.${kind}.${meta.namespace}.${meta.name}.${parentNamespace}.${text(parentRef.name)}`,
          'critical',
          `${kind} parent Gateway is missing`,
          `${meta.namespace}/${meta.name} references Gateway ${parentNamespace}/${text(parentRef.name)}, but it was not found.`,
          'Create the referenced Gateway or correct spec.parentRefs.',
          [routeRef, { kind: 'Gateway', namespace: parentNamespace, name: text(parentRef.name) }]
        ));
      }
    }

    for (const backendRef of routeBackendRefs(route)) {
      const backendGroup = text(backendRef.group);
      const backendKind = text(backendRef.kind) || 'Service';
      if ((backendGroup && backendGroup !== 'core') || backendKind !== 'Service') continue;
      const targetNamespace = text(backendRef.namespace) || meta.namespace;
      const backendName = text(backendRef.name);
      const targetRef = { kind: 'Service', namespace: targetNamespace, name: backendName };
      const targetVisible = !namespaceScope || namespaceScope === 'all' || targetNamespace === namespaceScope;
      const service = serviceMap.get(serviceKey(targetNamespace, backendName));

      if (!service) {
        if (targetVisible && !servicesPartial) {
          items.push(finding(
            `networking.route.missing_backend.${kind}.${meta.namespace}.${meta.name}.${targetNamespace}.${backendName}`,
            'critical',
            `${kind} backend Service is missing`,
            `${meta.namespace}/${meta.name} references Service ${targetNamespace}/${backendName}, but it was not found.`,
            'Create the backend Service or correct the route backendRef.',
            [routeRef, targetRef]
          ));
        }
        continue;
      }

      if (!servicePortMatches(service, backendRef.port)) {
        items.push(finding(
          `networking.route.backend_port.${kind}.${meta.namespace}.${meta.name}.${targetNamespace}.${backendName}.${String(backendRef.port)}`,
          'critical',
          `${kind} backend Service port is missing`,
          `${targetNamespace}/${backendName} does not expose port ${String(backendRef.port)} referenced by ${meta.namespace}/${meta.name}.`,
          'Correct the route backend port or add the expected Service port.',
          [routeRef, targetRef]
        ));
        continue;
      }

      if (targetNamespace !== meta.namespace && !grantsPartial &&
          !referenceGrantAllows(referenceGrants, kind, meta.namespace, targetNamespace, backendRef)) {
        items.push(finding(
          `networking.route.reference_not_permitted.${kind}.${meta.namespace}.${meta.name}.${targetNamespace}.${backendName}`,
          'critical',
          `${kind} cross-namespace backend is not permitted`,
          `${meta.namespace}/${meta.name} references ${targetNamespace}/${backendName} without a matching ReferenceGrant.`,
          'Create a ReferenceGrant in the backend namespace or keep the backend in the route namespace.',
          [routeRef, targetRef]
        ));
      }

      const endpointState = endpointStateForService(service, portRows, backendRef.port);
      if (endpointState.known && endpointState.ready === 0) {
        items.push(finding(
          `networking.route.no_ready_endpoints.${kind}.${meta.namespace}.${meta.name}.${targetNamespace}.${backendName}`,
          'critical',
          `${kind} backend has no ready endpoints`,
          `${targetNamespace}/${backendName} has 0/${endpointState.total} ready endpoints for route ${meta.namespace}/${meta.name}.`,
          'Inspect Service selectors, backing pods, readiness probes, and EndpointSlices.',
          [routeRef, targetRef]
        ));
      } else if (endpointState.known && endpointState.ready < endpointState.total) {
        items.push(finding(
          `networking.route.partial_endpoints.${kind}.${meta.namespace}.${meta.name}.${targetNamespace}.${backendName}`,
          'warning',
          `${kind} backend endpoints are partially ready`,
          `${targetNamespace}/${backendName} has ${endpointState.ready}/${endpointState.total} ready endpoints for route ${meta.namespace}/${meta.name}.`,
          'Inspect the Not Ready backend pods before route capacity degrades further.',
          [routeRef, targetRef]
        ));
      }
    }

    if (statusIsStale(route, parentConditions)) {
      items.push(finding(
        `networking.route.stale.${kind}.${meta.namespace}.${meta.name}`,
        'warning',
        `${kind} status is stale`,
        `${meta.namespace}/${meta.name} has not reconciled its current generation.`,
        'Check the Gateway controller and route status.',
        [routeRef]
      ));
    }
  }

  return [...new Map(items.map((item) => [item.id, item])).values()];
}
