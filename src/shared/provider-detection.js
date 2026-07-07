function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizedHostname(serverUrl) {
  const normalized = normalizeString(serverUrl);
  if (!normalized) return '';
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function execSignature(command, args) {
  return [normalizeLower(command), ...(Array.isArray(args) ? args.map((entry) => normalizeLower(entry)) : [])].filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)));
}

function guidanceFor(kind) {
  switch (kind) {
    case 'aws-eks':
      return [
        'EKS contexts commonly depend on local AWS CLI exec auth.',
        'Use agent when access relies on aws eks get-token or local AWS credentials.'
      ];
    case 'gcp-gke':
      return [
        'GKE contexts often rely on local gcloud-based exec auth.',
        'Use agent when this context depends on gke-gcloud-auth-plugin or local Google credentials.'
      ];
    case 'azure-aks':
      return [
        'AKS contexts commonly use kubelogin or Azure exec auth locally.',
        'Use agent when this context depends on Azure CLI or kubelogin on the customer machine.'
      ];
    case 'digitalocean-kubernetes':
      return [
        'DigitalOcean contexts may use doctl-generated auth or provider-specific endpoints.',
        'Use agent when direct mode is unreliable or the context depends on local doctl state.'
      ];
    case 'unknown':
      return ['Provider signals are mixed or incomplete.', 'Prefer agent if browser-direct behavior is unreliable for this context.'];
    default:
      return [];
  }
}

export function providerLabel(kind) {
  switch (kind) {
    case 'aws-eks':
      return 'AWS EKS';
    case 'gcp-gke':
      return 'GKE';
    case 'azure-aks':
      return 'AKS';
    case 'digitalocean-kubernetes':
      return 'DigitalOcean';
    case 'unknown':
      return 'Unknown provider';
    default:
      return 'Generic Kubernetes';
  }
}

export function detectProviderMetadata(input = {}) {
  const scores = new Map();
  const evidence = new Map();
  const contextName = normalizeString(input.contextName);
  const clusterName = normalizeString(input.clusterName);
  const userName = normalizeString(input.userName);
  const host = normalizedHostname(input.serverUrl);
  const signature = execSignature(input.execCommand, input.execArgs);
  const joinedSignature = signature.join(' ');
  const contextLower = contextName.toLowerCase();
  const clusterLower = clusterName.toLowerCase();
  const userLower = userName.toLowerCase();

  function push(kind, weight, message) {
    scores.set(kind, (scores.get(kind) ?? 0) + weight);
    evidence.set(kind, uniqueStrings([...(evidence.get(kind) ?? []), message]));
  }

  if (joinedSignature.includes('aws eks get-token')) {
    push('aws-eks', 5, 'exec auth: aws eks get-token');
  }
  if (joinedSignature.includes('aws-iam-authenticator')) {
    push('aws-eks', 5, 'exec auth: aws-iam-authenticator');
  }
  if (host.includes('.eks.amazonaws.com')) {
    push('aws-eks', 4, 'endpoint matches *.eks.amazonaws.com');
  }
  if (contextLower.includes('arn:aws:eks:') || clusterLower.includes('arn:aws:eks:') || userLower.includes('arn:aws:eks:')) {
    push('aws-eks', 3, 'name pattern: arn:aws:eks');
  }

  if (joinedSignature.includes('gke-gcloud-auth-plugin')) {
    push('gcp-gke', 5, 'exec auth: gke-gcloud-auth-plugin');
  }
  if (signature.includes('gcloud')) {
    push('gcp-gke', 4, 'exec auth: gcloud');
  }
  if (contextLower.startsWith('gke_') || clusterLower.startsWith('gke_')) {
    push('gcp-gke', 3, 'name pattern: gke_*');
  }
  if (host.includes('.gke.goog')) {
    push('gcp-gke', 4, 'endpoint matches *.gke.goog');
  }

  if (signature.includes('kubelogin')) {
    push('azure-aks', 5, 'exec auth: kubelogin');
  }
  if (signature.includes('az') && joinedSignature.includes('aks')) {
    push('azure-aks', 4, 'exec auth: Azure CLI AKS flow');
  }
  if (host.includes('.azmk8s.io')) {
    push('azure-aks', 4, 'endpoint matches *.azmk8s.io');
  }
  if (contextLower.includes('aks-') || clusterLower.includes('aks-')) {
    push('azure-aks', 2, 'name pattern: aks-*');
  }

  if (signature.includes('doctl')) {
    push('digitalocean-kubernetes', 5, 'exec auth: doctl');
  }
  if (host.includes('.k8s.ondigitalocean.com')) {
    push('digitalocean-kubernetes', 4, 'endpoint matches *.k8s.ondigitalocean.com');
  }
  if (contextLower.startsWith('do-') || clusterLower.startsWith('do-') || contextLower.includes('digitalocean') || clusterLower.includes('digitalocean')) {
    push('digitalocean-kubernetes', 2, 'name pattern: do-* / digitalocean');
  }

  const ranked = Array.from(scores.entries()).sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0) {
    return {
      kind: 'generic-kubernetes',
      confidence: 'low',
      evidence: [],
      hints: []
    };
  }

  const topScore = ranked[0][1];
  const topKinds = ranked.filter((entry) => entry[1] === topScore).map((entry) => entry[0]);
  if (topKinds.length > 1) {
    return {
      kind: 'unknown',
      confidence: topScore >= 4 ? 'medium' : 'low',
      evidence: uniqueStrings(topKinds.flatMap((kind) => evidence.get(kind) ?? [])),
      hints: guidanceFor('unknown')
    };
  }

  const [kind] = ranked[0];
  return {
    kind,
    confidence: topScore >= 4 ? 'high' : topScore >= 3 ? 'medium' : 'low',
    evidence: evidence.get(kind) ?? [],
    hints: guidanceFor(kind)
  };
}
