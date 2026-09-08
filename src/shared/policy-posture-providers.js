// Shared lightweight markers; these never trigger policy/report collection.
export const POLICY_PROVIDER_DEFINITIONS = [
  { id: 'kyverno', name: 'Kyverno', groups: ['kyverno.io', 'policies.kyverno.io'], images: ['kyverno/kyverno', 'kyverno/kyverno-background-controller', 'kyverno/kyverno-reports-controller', 'kyverno/kyverno-cleanup-controller'] },
  { id: 'gatekeeper', name: 'Gatekeeper', groups: ['templates.gatekeeper.sh', 'constraints.gatekeeper.sh'], images: ['openpolicyagent/gatekeeper'] },
  { id: 'kubewarden', name: 'Kubewarden', groups: ['policies.kubewarden.io'], images: ['kubewarden/kubewarden-controller', 'kubewarden/policy-server'] }
];

export function matchesPolicyControllerWorkload(workload, provider) {
  const containers = workload?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) return false;
  return containers.some((container) => {
    if (typeof container?.image !== 'string') return false;
    const repository = container.image.toLowerCase().split('@')[0].replace(/:[^/]+$/, '');
    return provider.images.some((image) => repository === image || repository.endsWith(`/${image}`));
  });
}
