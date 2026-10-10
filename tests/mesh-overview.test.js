import { describe, expect, test } from "bun:test";
import { buildMeshOverview, describeMatch } from "../src/shared/mesh-overview.js";
const obj = (kind, name, namespace, spec = {}) => ({ kind, metadata: { name, namespace }, spec });
const pod = (name, namespace, labels, sidecar) => ({
  metadata: { name, namespace, labels, ownerReferences: [{ kind: "ReplicaSet", name: `${labels.app}-5d8f9c7b6d`, controller: true }] },
  spec: { containers: [{ name: "app", image: "app:1" }, ...sidecar ? [{ name: "istio-proxy", image: `docker.io/istio/proxyv2:${sidecar}` }] : []] },
  status: { phase: "Running" }
});
describe("mesh overview", () => {
  test("returns undefined without Istio", () => {
    expect(buildMeshOverview({ pods: [pod("a", "x", { app: "a" }, null)], deployments: [], namespaces: [] })).toBeUndefined();
  });
  test("summarises control plane, coverage, findings, routes, policies and registry", () => {
    const overview = buildMeshOverview({
      namespaces: [
        { metadata: { name: "payments", labels: { "istio-injection": "enabled" } } },
        { metadata: { name: "argocd", labels: { "istio-injection": "enabled" } } },
        { metadata: { name: "istio-system" } }
      ],
      deployments: [
        { metadata: { name: "istiod", namespace: "istio-system" }, spec: { replicas: 1, template: { spec: { containers: [{ image: "docker.io/istio/pilot:1.24.2" }] } } }, status: { readyReplicas: 1 } }
      ],
      daemonSets: [],
      services: [obj("Service", "checkout", "payments", { selector: { app: "checkout" } })],
      pods: [
        pod("checkout-1", "payments", { app: "checkout", track: "stable" }, "1.23.1"),
        pod("repo-1", "argocd", { app: "repo" }, null),
        pod("server-1", "argocd", { app: "server" }, "1.24.2")
      ],
      virtualServices: [obj("VirtualService", "checkout", "payments", { hosts: ["checkout.payments.svc"], http: [{ route: [{ destination: { host: "checkout", subset: "stable" }, weight: 50 }, { destination: { host: "checkout", subset: "canary" }, weight: 50 }], fault: { delay: { fixedDelay: "2s", percentage: { value: 5 } } }, retries: { attempts: 2 } }] })],
      destinationRules: [obj("DestinationRule", "checkout", "payments", { host: "checkout", subsets: [{ name: "stable", labels: { track: "stable" } }, { name: "canary", labels: { track: "canary" } }], trafficPolicy: { connectionPool: { tcp: { maxConnections: 100 } } } })],
      peerAuthentications: [obj("PeerAuthentication", "default", "istio-system", { mtls: { mode: "STRICT" } }), obj("PeerAuthentication", "vault-permissive", "vault-system", { selector: { matchLabels: { app: "vault" } }, mtls: { mode: "PERMISSIVE" } })],
      authorizationPolicies: [obj("AuthorizationPolicy", "deny-all", "payments", {}), obj("AuthorizationPolicy", "checkout-allow", "payments", { selector: { matchLabels: { app: "checkout" } }, action: "ALLOW", rules: [{ from: [{ source: { principals: ["cluster.local/ns/kubi-saas/sa/api"] } }], to: [{ operation: { methods: ["POST"], paths: ["/v1/charge"] } }] }] })],
      requestAuthentications: [obj("RequestAuthentication", "jwt-auth", "kubi-saas", { jwtRules: [{ issuer: "https://auth.kubi.live" }] })],
      serviceEntries: [obj("ServiceEntry", "stripe-api", "istio-system", { hosts: ["api.stripe.com"], ports: [{ number: 443, protocol: "TLS" }], location: "MESH_EXTERNAL", resolution: "DNS" })],
      configMaps: [{ metadata: { name: "istio", namespace: "istio-system" }, data: { mesh: `outboundTrafficPolicy:
  mode: REGISTRY_ONLY
` } }]
    });
    expect(overview.provider).toMatchObject({ version: "1.24.2", mode: "sidecar", meshMtls: "STRICT", podsInMesh: 2, podsTotal: 3, istiod: "1/1" });
    expect(overview.components.find((component) => component.name === "istio-egressgateway")?.state).toBe("not installed");
    expect(overview.coverage.find((row) => row.namespace === "argocd")).toMatchObject({ injected: 1, total: 2, mtls: "STRICT" });
    const titles = overview.findings.map((finding) => finding.title);
    expect(titles[0]).toBe("Canary subset has no pods");
    expect(titles).toContain("Injection enabled but pods lack sidecars");
    expect(titles).toContain("mTLS is PERMISSIVE");
    expect(titles).toContain("Proxy older than control plane");
    expect(titles).toContain("Fault injection in payments");
    expect(overview.routes[0].rules[0].destinations).toEqual([{ label: "checkout:stable", weight: 50 }, { label: "checkout:canary", weight: 50 }]);
    expect(overview.routes[0].resilience).toEqual(["retries 2", "fault: delay 2s · 5%"]);
    expect(overview.policies.find((policy) => policy.name === "deny-all")).toMatchObject({ effect: "DENY", details: ["everything not explicitly allowed"] });
    expect(overview.policies.find((policy) => policy.name === "checkout-allow")?.details).toEqual(["from sa kubi-saas/api", "to POST /v1/charge"]);
    expect(overview.policies.find((policy) => policy.name === "default")).toMatchObject({ appliesTo: "mesh-wide", effect: "STRICT" });
    expect(overview.registry).toMatchObject({ outboundPolicy: "REGISTRY_ONLY", entries: [{ hosts: ["api.stripe.com"], ports: ["443/TLS"], usedBy: [] }] });
  });
  test("describes route matches", () => {
    expect(describeMatch({ headers: { "x-canary": { exact: "true" } } })).toBe("header x-canary = true");
    expect(describeMatch({ uri: { prefix: "/ws" } })).toBe("prefix /ws");
    expect(describeMatch({ authority: { exact: "www.kubi.live" } })).toBe("host www.kubi.live");
    expect(describeMatch({})).toBe("prefix /");
  });
});
