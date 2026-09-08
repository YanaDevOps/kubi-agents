import { describe, expect, test } from "bun:test";
import { collectPolicyPosture } from "../src/shared/policy-posture.js";
function requestFixture(overrides = {}) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    const url = new URL(path, "https://kubernetes.invalid");
    const value = overrides[url.pathname];
    if (value instanceof Error)
      throw value;
    if (typeof value === "function")
      return value(url);
    if (value)
      return value;
    if (url.pathname === "/version")
      return { gitVersion: "v1.34.0" };
    if (url.pathname === "/apis")
      return { groups: [] };
    return { items: [], metadata: {} };
  };
  return { request, calls };
}
describe("policy posture collection", () => {
  test("empty accessible inventory keeps Workload and Network available without inventing an admission provider", async () => {
    const fixture = requestFixture();
    const summary = await collectPolicyPosture(fixture);
    expect(summary.partial).toBe(false);
    expect(summary.tabs.workload.available).toBe(true);
    expect(summary.tabs.network.available).toBe(true);
    expect(summary.tabs.admission.available).toBe(false);
    expect(summary.tabs["image-trust"].available).toBe(false);
    expect(fixture.calls.some((path) => /secrets|configmaps/.test(path))).toBe(false);
  });
  test("RBAC denied is not mistaken for missing APIs or absence of network coverage", async () => {
    const fixture = requestFixture({
      "/apis": new Error("Kubernetes API responded with HTTP 403."),
      "/apis/networking.k8s.io/v1/networkpolicies": new Error("Kubernetes API responded with HTTP 403.")
    });
    const summary = await collectPolicyPosture(fixture);
    expect(summary.partial).toBe(true);
    expect(summary.sources.find((source) => source.id === "api-discovery")?.status).toBe("denied");
    expect(summary.tabs.network.available).toBe(false);
    expect(summary.findings.filter((finding) => finding.category === "network")).toEqual([]);
  });
  test("pages namespaced inventory and encodes scope without reading Secret data", async () => {
    const fixture = requestFixture({
      "/api/v1/namespaces/team-a/pods": (url) => ({ items: [], metadata: url.searchParams.has("continue") ? {} : { continue: "next token" } })
    });
    const summary = await collectPolicyPosture({ ...fixture, namespace: "team-a" });
    expect(summary.namespace).toBe("team-a");
    expect(fixture.calls.filter((path) => path.startsWith("/api/v1/namespaces/team-a/pods"))).toHaveLength(2);
    expect(fixture.calls.some((path) => path.includes("continue=next+token"))).toBe(true);
    expect(fixture.calls.some((path) => path.startsWith("/api/v1/pods?"))).toBe(false);
  });
  test("truncation and malformed successful responses are explicit incomplete coverage", async () => {
    const fixture = requestFixture({
      "/api/v1/pods": { items: [], metadata: { continue: "repeated" } },
      "/apis/networking.k8s.io/v1/networkpolicies": { unexpected: true }
    });
    const summary = await collectPolicyPosture(fixture);
    expect(summary.partial).toBe(true);
    expect(summary.sources.find((source) => source.id === "pods")?.partial).toBe(true);
    expect(summary.sources.find((source) => source.id === "networkpolicies")?.status).toBe("error");
  });
  test("uses discovery preferred served version once per kind and excludes unrelated custom APIs", async () => {
    const fixture = requestFixture({
      "/apis": { groups: [{ name: "policies.kubewarden.io", preferredVersion: { groupVersion: "policies.kubewarden.io/v1" }, versions: [{ groupVersion: "policies.kubewarden.io/v1" }, { groupVersion: "policies.kubewarden.io/v1alpha2" }] }] },
      "/apis/policies.kubewarden.io/v1": { resources: [{ name: "admissionpolicies", kind: "AdmissionPolicy", namespaced: true, verbs: ["get", "list"] }, { name: "unrelated", kind: "Credential", namespaced: true, verbs: ["list"] }] },
      "/apis/policies.kubewarden.io/v1alpha2": { resources: [{ name: "admissionpolicies", kind: "AdmissionPolicy", namespaced: true, verbs: ["list"] }] }
    });
    await collectPolicyPosture({ ...fixture, namespace: "team-a" });
    expect(fixture.calls.some((path) => path.startsWith("/apis/policies.kubewarden.io/v1/namespaces/team-a/admissionpolicies?"))).toBe(true);
    expect(fixture.calls.some((path) => path.includes("v1alpha2/namespaces"))).toBe(false);
    expect(fixture.calls.some((path) => path.includes("/unrelated"))).toBe(false);
  });
  test("malformed discovery arrays and descriptors stay source-local instead of throwing", async () => {
    const group = { name: "kyverno.io", preferredVersion: { groupVersion: "kyverno.io/v1" }, versions: [{ groupVersion: "kyverno.io/v1" }] };
    for (const overrides of [
      { "/apis": { groups: {} } },
      { "/apis": { groups: "invalid" } },
      { "/apis": { groups: [null, 12, { name: false }] } },
      { "/apis": { groups: [{ ...group, versions: {} }] } },
      { "/apis": { groups: [{ ...group, preferredVersion: null, versions: [null] }] } },
      { "/apis": { groups: [group] }, "/apis/kyverno.io/v1": { resources: {} } },
      { "/apis": { groups: [group] }, "/apis/kyverno.io/v1": { resources: [null, {}, { name: "policies", verbs: "list" }] } }
    ]) {
      const result = await collectPolicyPosture(requestFixture(overrides));
      expect(result.partial).toBe(true);
      expect(result.tabs.workload.available).toBe(true);
      expect(result.sources.some((source) => source.status === "error" && source.partial)).toBe(true);
    }
  });
  test("discovery cannot inject arbitrary paths or claim a version from another group", async () => {
    const fixture = requestFixture({ "/apis": { groups: [{ name: "kyverno.io", versions: [
      { groupVersion: "../api/v1/secrets" },
      { groupVersion: "kyverno.io/v1/../../secrets" },
      { groupVersion: "unrelated.io/v1" },
      { groupVersion: "kyverno.io/v1?token=private" }
    ] }] } });
    const result = await collectPolicyPosture(fixture);
    expect(result.partial).toBe(true);
    expect(fixture.calls.some((path) => /secrets|private|unrelated/.test(path))).toBe(false);
  });
  test("required-source and advertised-source 404s never produce clean coverage", async () => {
    for (const missing of ["/api/v1/pods", "/apis", "/version"]) {
      const result = await collectPolicyPosture(requestFixture({ [missing]: new Error("HTTP 404") }));
      expect(result.partial).toBe(true);
      expect(result.sources.find((source) => source.status === "absent")?.partial).toBe(true);
    }
    const result = await collectPolicyPosture(requestFixture({
      "/apis": { groups: [{ name: "kyverno.io", versions: [{ groupVersion: "kyverno.io/v1" }] }] },
      "/apis/kyverno.io/v1": new Error("HTTP 404")
    }));
    expect(result.partial).toBe(true);
    expect(result.tabs.admission.reason).not.toContain("No supported");
  });
  test("denied pod inventory suppresses absence claims but preserves observed unsafe policy declarations", async () => {
    const result = await collectPolicyPosture(requestFixture({
      "/api/v1/pods": new Error("HTTP 403"),
      "/apis/networking.k8s.io/v1/networkpolicies": { items: [{
        metadata: { name: "open", namespace: "apps" },
        spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{}] }
      }] }
    }));
    expect(result.findings.some((finding) => finding.id.startsWith("network:allow-all-ingress:"))).toBe(true);
    expect(result.findings.some((finding) => /network:(missing-coverage|unmatched-selector):/.test(finding.id))).toBe(false);
    expect(result.coverage.network).toMatchObject({ partial: true });
  });
  test("unsupported workload reference versions propagate analysis partial to the runtime summary", async () => {
    const result = await collectPolicyPosture(requestFixture({ "/version": { gitVersion: "v1.36.2" } }));
    expect(result.partial).toBe(true);
    expect(result.coverage.workload).toMatchObject({ partial: true, versionAssumed: true });
    expect(result.sources).toContainEqual(expect.objectContaining({ id: "workload-analysis", partial: true }));
  });
  test("admission receives completeness only for supplied known inventories and within the requested scope", async () => {
    const reportPath = "/apis/wgpolicyk8s.io/v1alpha2/namespaces/apps/policyreports";
    const reports = (target) => ({
      "/apis": { groups: [{ name: "wgpolicyk8s.io", versions: [{ groupVersion: "wgpolicyk8s.io/v1alpha2" }] }] },
      "/apis/wgpolicyk8s.io/v1alpha2": { resources: [{ name: "policyreports", kind: "PolicyReport", namespaced: true, verbs: ["list"] }] },
      [reportPath]: { items: [{
        metadata: { name: "report", namespace: "apps" },
        results: [{ result: "fail", source: "kyverno", policy: "check", resources: [target] }]
      }] }
    });
    for (const [kind, apiVersion, path] of [
      ["Pod", "v1", "/api/v1/namespaces/apps/pods"],
      ["Deployment", "apps/v1", "/apis/apps/v1/namespaces/apps/deployments"],
      ["Namespace", "v1", "/api/v1/namespaces"]
    ]) {
      const target = { kind, apiVersion, name: kind === "Namespace" ? "apps" : "missing", namespace: kind === "Namespace" ? "" : "apps" };
      const complete = await collectPolicyPosture({ ...requestFixture(reports(target)), namespace: "apps" });
      expect(complete.findings.filter((finding) => finding.category === "admission")).toHaveLength(0);
      expect(complete.policies[0]?.configuration).toMatchObject({ missingResourceResultCount: 1 });
      const denied = await collectPolicyPosture({ ...requestFixture({ ...reports(target), [path]: new Error("HTTP 403") }), namespace: "apps" });
      expect(denied.findings.filter((finding) => finding.category === "admission")).toHaveLength(1);
      expect(denied.policies[0]?.configuration).toMatchObject({ missingResourceResultCount: 0 });
    }
    for (const target of [
      { kind: "Pod", apiVersion: "v1", name: "outside", namespace: "other" },
      { kind: "Namespace", apiVersion: "v1", name: "other", namespace: "" },
      { kind: "NetworkPolicy", apiVersion: "networking.k8s.io/v1", name: "unknown-in-admission", namespace: "apps" },
      { kind: "CustomResource", apiVersion: "other.io/v1", name: "unknown", namespace: "apps" }
    ]) {
      const result = await collectPolicyPosture({ ...requestFixture(reports(target)), namespace: "apps" });
      expect(result.policies[0]?.configuration).toMatchObject({ missingResourceResultCount: 0 });
    }
  });
  test("cache isolates transport identity and namespace, expires, and never returns mutable shared data", async () => {
    const first = requestFixture();
    const second = requestFixture();
    const initial = await collectPolicyPosture({ ...first, namespace: "apps" });
    const initialReads = first.calls.length;
    initial.sources.length = 0;
    const cached = await collectPolicyPosture({ ...first, namespace: "apps" });
    expect(cached.sources.length).toBeGreaterThan(0);
    expect(first.calls).toHaveLength(initialReads);
    await collectPolicyPosture({ ...first, namespace: "other" });
    expect(first.calls.length).toBeGreaterThan(initialReads);
    await collectPolicyPosture({ ...second, namespace: "apps" });
    expect(second.calls.length).toBeGreaterThan(0);
    const readsBeforeRefresh = first.calls.length;
    await collectPolicyPosture({ ...first, namespace: "apps", forceRefresh: true });
    expect(first.calls.length).toBeGreaterThan(readsBeforeRefresh);
    const readsBeforeExpiry = first.calls.length;
    const future = Date.now() + 30001;
    const now = Date.now;
    Date.now = () => future;
    try {
      await collectPolicyPosture({ ...first, namespace: "apps" });
      expect(first.calls.length).toBeGreaterThan(readsBeforeExpiry);
    } finally {
      Date.now = now;
    }
  });
  test("refresh joins an existing collection and all/null scope share one cache key", async () => {
    const fixture = requestFixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const request = async (path) => {
      await gate;
      return fixture.request(path);
    };
    const first = collectPolicyPosture({ request, namespace: "all" });
    const refresh = collectPolicyPosture({ request, namespace: null, forceRefresh: true });
    release();
    const results = await Promise.all([first, refresh]);
    expect(fixture.calls.filter((path) => path === "/apis")).toHaveLength(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).not.toBe(results[1]);
    await collectPolicyPosture({ request });
    expect(fixture.calls.filter((path) => path === "/apis")).toHaveLength(1);
  });
  test("bounds retained namespace cache entries per transport", async () => {
    const fixture = requestFixture();
    for (let index = 0;index < 9; index++)
      await collectPolicyPosture({ ...fixture, namespace: `scope-${index}` });
    const reads = fixture.calls.length;
    await collectPolicyPosture({ ...fixture, namespace: "scope-0" });
    expect(fixture.calls.length).toBeGreaterThan(reads);
  });
  test("passes abort and body-byte limits, never exceeds four active transports, and aborts overdue reads", async () => {
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (handler, delay) => schedule(handler, delay === 5000 ? 5 : delay);
    let active = 0;
    let peak = 0;
    let aborted = 0;
    try {
      const result = await collectPolicyPosture({ request: async (_path, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.maxBytes).toBeGreaterThan(0);
        expect(options.maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        peak = Math.max(peak, ++active);
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
          active--;
          aborted++;
          reject(options.signal.reason);
        }, { once: true }));
      } });
      expect(result.partial).toBe(true);
      expect(active).toBe(0);
      expect(peak).toBeLessThanOrEqual(4);
      expect(aborted).toBeGreaterThan(0);
    } finally {
      globalThis.setTimeout = schedule;
    }
  });
  test("noncooperating transports cannot cause unbounded replacement requests after timeout", async () => {
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (handler, delay) => schedule(handler, delay === 5000 ? 5 : delay);
    let reads = 0;
    try {
      const result = await collectPolicyPosture({ request: async () => {
        reads++;
        return new Promise(() => {});
      } });
      expect(result.partial).toBe(true);
      expect(reads).toBe(4);
    } finally {
      globalThis.setTimeout = schedule;
    }
  });
  test("oversized reads and servers ignoring requested page size are explicit partial sources", async () => {
    for (const payload of [
      { items: [], extra: "x".repeat(4 * 1024 * 1024) },
      { items: Array.from({ length: 251 }, (_, index) => ({ metadata: { name: `pod-${index}` } })) }
    ]) {
      const result = await collectPolicyPosture(requestFixture({ "/api/v1/pods": payload }));
      expect(result.partial).toBe(true);
      expect(result.sources.find((source) => source.id === "pods")).toMatchObject({ status: "error", partial: true });
    }
  });
  test("dense network inventory has a separate analysis budget without false absence findings", async () => {
    const fixture = requestFixture({
      "/api/v1/pods": (url) => {
        const page = Number(url.searchParams.get("continue") || 0);
        return { items: Array.from({ length: 250 }, (_, index) => ({
          metadata: { name: `pod-${page}-${index}`, namespace: "apps" },
          spec: { containers: [{ name: "app", image: "example:stable" }] }
        })), metadata: page < 9 ? { continue: String(page + 1) } : {} };
      },
      "/apis/networking.k8s.io/v1/networkpolicies": { items: Array.from({ length: 101 }, (_, index) => ({
        metadata: { name: `policy-${index}`, namespace: "other" },
        spec: { podSelector: {}, ingress: [] }
      })) }
    });
    const result = await collectPolicyPosture(fixture);
    expect(result.partial).toBe(true);
    expect(result.sources).toContainEqual(expect.objectContaining({ id: "network-analysis-limit", partial: true, count: 100 }));
    expect(result.coverage.network).toMatchObject({ partial: true, analyzedPolicies: 100, omittedPolicies: 1 });
    expect(result.findings.some((finding) => finding.id.startsWith("network:missing-coverage:"))).toBe(false);
  });
  test("serialized output stays below 2 MiB with explicit omission counts and no raw sensitive spec", async () => {
    const fixture = requestFixture({ "/api/v1/pods": (url) => {
      const page = Number(url.searchParams.get("continue") || 0);
      return { items: Array.from({ length: 250 }, (_, index) => ({
        metadata: { name: `pod-${page}-${index}`, namespace: "apps" },
        spec: { hostNetwork: true, hostPID: true, hostIPC: true, containers: [{
          name: "app",
          image: "example:latest",
          env: [{ name: "PRIVATE", value: "private-sensitive-sentinel" }],
          securityContext: { privileged: true, allowPrivilegeEscalation: true, runAsUser: 0 }
        }] }
      })), metadata: page < 9 ? { continue: String(page + 1) } : {} };
    } });
    const result = await collectPolicyPosture(fixture);
    const json = JSON.stringify(result);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(result.partial).toBe(true);
    expect(result.sources).toContainEqual(expect.objectContaining({ id: "output-limit", partial: true }));
    const collection = result.coverage.collection;
    expect(collection.truncated).toBe(true);
    expect(collection.counts.findings.omitted).toBeGreaterThan(0);
    expect(collection.counts.findings.returned).toBe(result.findings.length);
    expect(collection.counts.findings.total).toBe(collection.counts.findings.returned + collection.counts.findings.omitted);
    expect(Object.values(collection.findingsBySeverity).reduce((sum, count) => sum + count, 0)).toBe(collection.counts.findings.total);
    expect(json).not.toContain("private-sensitive-sentinel");
  });
});
