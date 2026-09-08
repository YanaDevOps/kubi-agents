import { describe, expect, test } from "bun:test";
import { analyzeNetworkPosture } from "../src/shared/policy-posture-network.js";
function pod(name = "web", labels = { app: "web" }, namespace = "apps") {
  return { kind: "Pod", metadata: { name, namespace, labels, uid: `${namespace}-${name}` }, spec: {} };
}
function policy(name = "deny", spec = {}, namespace = "apps") {
  return { kind: "NetworkPolicy", metadata: { name, namespace }, spec: { podSelector: {}, ...spec } };
}
function analyze(pods = [pod()], networkPolicies = [], namespaces = []) {
  return analyzeNetworkPosture({ pods, networkPolicies, namespaces });
}
function podItems(result) {
  return result.items.filter((item) => item.type === "pod");
}
describe("network policy posture", () => {
  test("empty inventories and malformed records are safe", () => {
    const result = analyze([null, {}, []], [null, {}, []]);
    expect(result.findings).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.coverage.totalPods).toBe(0);
    expect(result.coverage.enforcement).toBe("unknown");
  });
  test("missing directional coverage is informational, not a proven exposure", () => {
    const result = analyze();
    expect(podItems(result)[0]).toMatchObject({ ingress: { covered: false }, egress: { covered: false } });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      category: "network",
      severity: "info",
      system: false,
      resource: { kind: "Pod", name: "web", namespace: "apps", uid: "apps-web" }
    });
    expect(result.findings[0].id).toContain("missing-coverage");
    expect(result.findings[0].message).toContain("enforcement");
  });
  test("defaults to Ingress and adds Egress only for nonempty egress rules", () => {
    const defaulted = analyze([pod()], [policy("default", { egress: [] })]);
    expect(podItems(defaulted)[0]).toMatchObject({ ingress: { covered: true }, egress: { covered: false } });
    const withRules = analyze([pod()], [policy("egress-rule", { egress: [{}] })]);
    expect(podItems(withRules)[0]).toMatchObject({ ingress: { covered: true, allowAll: false }, egress: { covered: true, allowAll: true } });
    const explicit = analyze([pod()], [policy("only-egress", { policyTypes: ["Egress"], ingress: [{}] })]);
    expect(podItems(explicit)[0]).toMatchObject({ ingress: { covered: false }, egress: { covered: true, allowAll: false } });
    expect(explicit.findings.some((entry) => entry.id.includes("allow-all"))).toBe(false);
  });
  test("combines policies additively in each direction; deny cannot cancel allow-all", () => {
    const policies = [
      policy("deny", { policyTypes: ["Ingress", "Egress"] }),
      policy("allow", { ingress: [{}] })
    ];
    const result = analyze([pod()], policies);
    expect(podItems(result)[0]).toMatchObject({ ingress: { covered: true, allowAll: true }, egress: { covered: true, allowAll: false } });
    expect(podItems(result)[0].ingress.policies).toHaveLength(2);
    expect(result.coverage.bothCoveredPods).toBe(1);
    expect(result.findings.filter((entry) => entry.id.includes("allow-all"))).toHaveLength(1);
    expect(result.findings.find((entry) => entry.id.includes("allow-all"))?.severity).toBe("warning");
    expect(result.findings.some((entry) => entry.id.includes("missing-coverage"))).toBe(false);
  });
  for (const [operator, values, labels, selected] of [
    ["In", ["web"], { app: "web" }, true],
    ["In", ["web"], {}, false],
    ["NotIn", ["api"], { app: "web" }, true],
    ["NotIn", ["web"], { app: "web" }, false],
    ["NotIn", ["web"], {}, true],
    ["Exists", [], { app: "" }, true],
    ["Exists", [], {}, false],
    ["DoesNotExist", [], {}, true],
    ["DoesNotExist", [], { app: "" }, false],
    ["Unknown", [], {}, false]
  ]) {
    test(`matches ${operator} ${JSON.stringify(values)} against ${JSON.stringify(labels)} as ${selected}`, () => {
      const result = analyze([pod("target", labels)], [policy("expression", {
        podSelector: { matchExpressions: [{ key: "app", operator, values }] }
      })]);
      expect(podItems(result)[0].ingress.covered).toBe(selected);
    });
  }
  test("ANDs labels and expressions and never selects a different namespace", () => {
    const np = policy("select", { podSelector: {
      matchLabels: { app: "web" },
      matchExpressions: [{ key: "tier", operator: "Exists" }, { key: "disabled", operator: "DoesNotExist" }]
    } });
    const result = analyze([
      pod("yes", { app: "web", tier: "ui" }),
      pod("no"),
      pod("foreign", { app: "web", tier: "ui" }, "other")
    ], [np]);
    expect(podItems(result).filter((item) => item.ingress.covered).map((item) => item.resource.name)).toEqual(["yes"]);
  });
  test("intentional empty target selectors are configuration, not findings; unmatched selectors are visible", () => {
    const result = analyze([pod()], [policy(), policy("unmatched", { podSelector: { matchLabels: { app: "missing" } } })]);
    expect(result.findings.some((entry) => entry.id.includes("empty-selector"))).toBe(false);
    expect(result.findings.find((entry) => entry.id.includes("unmatched-selector"))?.severity).toBe("info");
    expect(result.findings.some((entry) => entry.severity === "warning")).toBe(false);
  });
  for (const rule of [{}, { from: [] }, { from: [{}], ports: [] }]) {
    test(`recognizes unrestricted ingress ${JSON.stringify(rule)}`, () => {
      const result = analyze([pod()], [policy("all", { ingress: [rule] })]);
      expect(podItems(result)[0].ingress.allowAll).toBe(true);
    });
  }
  for (const rule of [
    { ports: [{ port: 80 }] },
    { ports: [{}] },
    { from: [{ podSelector: {} }] },
    { from: [{ namespaceSelector: {} }] },
    { from: [{ namespaceSelector: {}, podSelector: { matchLabels: { app: "web" } } }] },
    { from: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8"] } }] }
  ]) {
    test(`does not call limited peers/ports unrestricted: ${JSON.stringify(rule)}`, () => {
      const result = analyze([pod()], [policy("limited", { ingress: [rule] })]);
      expect(podItems(result)[0].ingress.allowAll).toBe(false);
      expect(result.findings.some((entry) => entry.id.includes("allow-all"))).toBe(false);
    });
  }
  test("warns about all-address CIDRs with explicit IP-family scope, not universal enforcement", () => {
    const result = analyze([pod()], [policy("internet", {
      policyTypes: ["Egress"],
      egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }, { ipBlock: { cidr: "::/0" } }] }]
    })]);
    expect(result.findings.filter((entry) => entry.id.includes("allow-all-addresses"))).toHaveLength(1);
    expect(result.findings.find((entry) => entry.id.includes("allow-all-addresses"))?.evidence.join(" ")).toContain("IPv4");
    expect(podItems(result)[0].egress.allowAll).toBe(false);
  });
  test("reports nested empty selectors without confusing a namespace-local peer with all traffic", () => {
    const result = analyze([pod()], [policy("peer", {
      podSelector: { matchLabels: { app: "web" } },
      ingress: [{ from: [{ podSelector: {} }] }]
    })]);
    const item = result.items.find((entry) => entry.type === "policy");
    expect(item.configuration.emptySelectors.join(" ")).toContain("podSelector");
    expect(result.findings.some((entry) => entry.id.includes("empty-selector"))).toBe(false);
    expect(podItems(result)[0].ingress.allowAll).toBe(false);
  });
  test("exposes allowlisted rule configuration for the drawer without raw metadata or unknown fields", () => {
    const raw = policy("configured", {
      podSelector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "retired", operator: "DoesNotExist" }] },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { team: "backend" } },
          podSelector: { matchExpressions: [{ key: "role", operator: "In", values: ["api"] }] }
        }],
        ports: [{ port: "http" }, { protocol: "TCP", port: 8000, endPort: 9000 }],
        token: "OMIT_RULE_TOKEN"
      }],
      egress: [{
        to: [{ ipBlock: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"], credential: "OMIT_CREDENTIAL" } }],
        ports: [{ protocol: "UDP", port: 53 }]
      }],
      secret: "OMIT_SPEC_SECRET"
    });
    raw.metadata.annotations = { "kubectl.kubernetes.io/last-applied-configuration": "OMIT_MANIFEST" };
    const result = analyze([pod()], [raw]);
    const item = result.items.find((entry) => entry.type === "policy");
    expect(item).toMatchObject({
      id: expect.any(String),
      provider: "Kubernetes",
      kind: "NetworkPolicy",
      name: "configured",
      namespace: "apps",
      ruleCount: 2,
      mode: "Configuration only"
    });
    expect(item.configuration).toMatchObject({
      podSelector: raw.spec.podSelector,
      policyTypes: ["Ingress", "Egress"],
      policyTypesDefaulted: false,
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { team: "backend" } },
          podSelector: { matchExpressions: [{ key: "role", operator: "In", values: ["api"] }] }
        }],
        ports: [{ port: "http", protocol: "TCP" }, { protocol: "TCP", port: 8000, endPort: 9000 }]
      }],
      egress: [{
        to: [{ ipBlock: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] } }],
        ports: [{ protocol: "UDP", port: 53 }]
      }]
    });
    expect(JSON.stringify(result)).not.toContain("OMIT_");
    item.configuration.egress[0].to[0].ipBlock.except.push("10.2.0.0/16");
    expect(raw.spec.egress[0].to[0].ipBlock.except).toEqual(["10.1.0.0/16"]);
  });
  test("reports defaulted directions and empty selectors without a default-deny finding", () => {
    const result = analyze([pod()], [policy("deny", { policyTypes: ["Ingress", "Egress"] })]);
    expect(result.findings).toEqual([]);
    const item = result.items.find((entry) => entry.type === "policy");
    expect(item.configuration).toMatchObject({ podSelector: {}, ingress: [], egress: [] });
    expect(item.configuration.emptySelectors).toHaveLength(1);
    const defaulted = analyze([pod()], [policy("default", { egress: [] })]).items.find((entry) => entry.type === "policy");
    expect(defaulted.configuration).toMatchObject({ policyTypes: ["Ingress"], policyTypesDefaulted: true });
  });
  test("reports namespaces without policies, skips terminal pods, and flags hostNetwork uncertainty", () => {
    const done = pod("done");
    done.status = { phase: "Succeeded" };
    const failed = pod("failed");
    failed.status = { phase: "Failed" };
    const host = pod("host", {}, "kube-system");
    host.spec.hostNetwork = true;
    const result = analyze([done, failed, host], [], [{ metadata: { name: "empty" } }]);
    expect(result.coverage.totalPods).toBe(1);
    expect(result.coverage.excludedCompletedPods).toBe(2);
    expect(result.findings.some((entry) => entry.resource.kind === "Namespace" && entry.resource.name === "empty")).toBe(true);
    expect(result.findings.find((entry) => entry.id.includes("host-network"))).toMatchObject({ severity: "info", system: true });
    expect(result.coverage.enforcement).toBe("unknown");
  });
  test("is deterministic, preserves inputs and deduplicates repeated inventory resources", () => {
    const input = { pods: [pod("b"), pod("a")], networkPolicies: [policy("z"), policy("a")], namespaces: [] };
    const before = structuredClone(input);
    const result = analyzeNetworkPosture(input);
    expect(analyzeNetworkPosture({ ...input, pods: [...input.pods].reverse(), networkPolicies: [...input.networkPolicies].reverse() })).toEqual(result);
    expect(analyzeNetworkPosture({ ...input, pods: [...input.pods, input.pods[0]] })).toEqual(result);
    expect(input).toEqual(before);
    expect(new Set(result.findings.map((entry) => entry.id)).size).toBe(result.findings.length);
  });
});
