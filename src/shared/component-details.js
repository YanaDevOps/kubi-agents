// Object counts per CRD and workload readiness/version for the Platform components page.
// Counts use metadata-only lists with limit=1 (items + remainingItemCount), so no object bodies are read.
import { METADATA_ACCEPT } from './namespace-summary.js';

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');

function imageTag(image) {
  const match = /:([^:@/]+)(?:@.*)?$/.exec(text(image));
  return match ? match[1] : '';
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function collectComponentDetails({ request } = {}) {
  if (typeof request !== 'function') throw new TypeError('A customer-side request function is required.');
  const crdList = record(await request('/apis/apiextensions.k8s.io/v1/customresourcedefinitions'));
  const crds = list(crdList.items).map((crd) => {
    const spec = record(crd.spec);
    const version = list(spec.versions).find((entry) => record(entry).storage) || list(spec.versions)[0];
    return { name: text(record(crd.metadata).name), group: text(spec.group), version: text(record(version).name), plural: text(record(spec.names).plural), scope: text(spec.scope) };
  }).filter((crd) => crd.name && crd.plural && crd.version);
  const counts = await pool(crds, 6, async (crd) => {
    try {
      const payload = record(await request(`/apis/${crd.group}/${crd.version}/${crd.plural}?limit=1`, { accept: METADATA_ACCEPT }));
      return list(payload.items).length + (Number(record(payload.metadata).remainingItemCount) || 0);
    } catch {
      return null;
    }
  });
  const workloads = {};
  for (const [kind, path] of [['Deployment', '/apis/apps/v1/deployments'], ['StatefulSet', '/apis/apps/v1/statefulsets'], ['DaemonSet', '/apis/apps/v1/daemonsets']]) {
    let items = [];
    try {
      items = list(record(await request(path)).items);
    } catch {
      continue;
    }
    for (const item of items) {
      const meta = record(item.metadata);
      const status = record(item.status);
      const containers = list(record(record(record(item.spec).template).spec).containers);
      const ready = kind === 'DaemonSet' ? Number(status.numberReady) || 0 : Number(status.readyReplicas) || 0;
      const desired = kind === 'DaemonSet' ? Number(status.desiredNumberScheduled) || 0 : Number(record(item.spec).replicas ?? 1) || 0;
      workloads[`${text(meta.namespace)}/${kind.toLowerCase()}/${text(meta.name)}`] = { ready, desired, version: imageTag(record(containers[0]).image) };
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    crdCounts: Object.fromEntries(crds.map((crd, index) => [crd.name, counts[index]])),
    workloads
  };
}
