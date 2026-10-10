import { describe, expect, test } from "bun:test";
import { METADATA_ACCEPT, collectNamespaceSummary } from "../src/shared/namespace-summary.js";
const now = Date.parse("2026-10-09T06:00:00Z");
const meta = (name, namespace, extra = {}) => ({ metadata: { name, ...namespace ? { namespace } : {}, ...extra } });
function fakeRequest(data, calls) {
  return async (path, settings) => {
    const pathname = path.split("?")[0];
    calls.push([pathname, settings?.accept]);
    if (!(pathname in data))
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    return { items: data[pathname], metadata: {} };
  };
}
describe("namespace summary", () => {
  test("aggregates health, usage, owners and counts with metadata-only reads for counted kinds", async () => {
    const calls = [];
    const result = await collectNamespaceSummary({
      now,
      request: fakeRequest({
        "/api/v1/namespaces": [meta("argocd", undefined, { creationTimestamp: "2026-08-07T00:00:00Z" }), meta("kube-system"), meta("empty")],
        "/api/v1/pods": [
          { ...meta("server", "argocd"), status: { phase: "Running", containerStatuses: [{ restartCount: 3, state: { running: {} }, lastState: { terminated: { finishedAt: "2026-10-09T01:00:00Z" } } }] } },
          { ...meta("repo", "argocd"), status: { phase: "Running", containerStatuses: [{ restartCount: 26, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
          { ...meta("done", "argocd", { ownerReferences: [{ kind: "Job", name: "x" }] }), status: { phase: "Succeeded" } },
          { ...meta("dns", "kube-system"), status: { phase: "Running", containerStatuses: [{ restartCount: 0, state: { running: {} } }] } }
        ],
        "/api/v1/nodes": [meta("node-1", undefined, { annotations: { "k3s.io/node-args": "[]" } })],
        "/apis/metrics.k8s.io/v1beta1/pods": [{ ...meta("server", "argocd"), containers: [{ usage: { cpu: "15000000n", memory: "100Mi" } }] }],
        "/apis/apps/v1/deployments": [meta("server", "argocd", { labels: { "app.kubernetes.io/managed-by": "Helm", "helm.sh/chart": "argo-cd-10.3.0" } }), meta("coredns", "kube-system")],
        "/apis/apps/v1/statefulsets": [],
        "/apis/apps/v1/daemonsets": [],
        "/api/v1/services": [meta("server", "argocd")],
        "/api/v1/configmaps": [meta("cm", "argocd")],
        "/api/v1/secrets": [meta("s", "argocd")],
        "/api/v1/resourcequotas": [],
        "/api/v1/limitranges": []
      }, calls)
    });
    const argocd = result.items.find((item) => item.name === "argocd");
    expect(argocd.pods).toMatchObject({ total: 3, running: 1, notRunning: 1, restarts: 29, restarts24h: 3, problem: "CrashLoopBackOff" });
    expect(argocd.usage).toEqual({ cpuMilli: 15, memoryBytes: 100 * 1024 ** 2 });
    expect(argocd.managedBy).toEqual({ tool: "Helm", name: "argo-cd-10.3.0" });
    expect(argocd.counts).toMatchObject({ Deployment: 1, Service: 1, ConfigMap: 1, Secret: 1 });
    expect(result.items.find((item) => item.name === "kube-system")?.managedBy).toEqual({ tool: "k3s" });
    expect(result.items.find((item) => item.name === "empty")?.pods.total).toBe(0);
    expect(calls.find(([path]) => path === "/api/v1/secrets")?.[1]).toBe(METADATA_ACCEPT);
    expect(calls.find(([path]) => path === "/api/v1/configmaps")?.[1]).toBe(METADATA_ACCEPT);
    expect(result.sources.find((source) => source.id === "Ingress")?.status).toBe("absent");
    expect(result.metricsAvailable).toBe(true);
  });
});
