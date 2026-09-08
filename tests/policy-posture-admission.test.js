import { describe, expect, test } from "bun:test";
import { analyzeAdmissionPosture } from "../src/shared/policy-posture-admission.js";
const raw = (apiVersion, kind, name, spec = {}, namespace = "") => ({
  apiVersion,
  kind,
  metadata: { name, ...namespace ? { namespace } : {} },
  spec
});
const pod = (name = "web", uid = "current", namespace = "apps") => ({
  ...raw("v1", "Pod", name, {}, namespace),
  metadata: { name, namespace, uid }
});
const ref = (name = "web", uid = "current", namespace = "apps") => ({ apiVersion: "v1", kind: "Pod", name, namespace, uid });
const result = (outcome = "fail", extra = {}) => ({
  source: "kyverno",
  policy: "require-labels",
  rule: "labels",
  result: outcome,
  timestamp: { seconds: 1700000000, nanos: 0 },
  ...extra
});
const report = (results = [result()], extra = {}) => ({
  ...raw("wgpolicyk8s.io/v1alpha2", "PolicyReport", "report", {}, "apps"),
  scope: ref(),
  results,
  ...extra
});
const analyze = (resources, extra = {}) => analyzeAdmissionPosture({ resources, ...extra });
const item = (output, name) => output.items.find((entry) => entry.name === name);
describe("pure admission posture adapters", () => {
  test("handles absent and malformed input without inventing installed providers", () => {
    expect(analyze([])).toEqual({ items: [], findings: [], providers: [], imageTrust: [] });
    expect(analyzeAdmissionPosture(null)).toEqual(analyze([]));
    expect(analyze([null, 1, [], {}, raw("example.io/v1", "Policy", "unrelated")])).toEqual(analyze([]));
    expect(analyze([raw("__proto__/v1", "Policy", "unrelated"), raw("constructor/v1", "Policy", "unrelated")])).toEqual(analyze([]));
  });
  test("counts the documented Kyverno generation expressions and deletion conditions", () => {
    const output = analyze([
      raw("policies.kyverno.io/v1", "GeneratingPolicy", "generate", { generate: [{ expression: "LEAK" }, { expression: "LEAK" }] }),
      raw("policies.kyverno.io/v1", "DeletingPolicy", "delete", { conditions: [{ expression: "LEAK" }], schedule: "* * * * *" })
    ]);
    expect(item(output, "generate")).toMatchObject({ mode: "generate", ruleCount: 2 });
    expect(item(output, "delete")).toMatchObject({ mode: "delete", ruleCount: 1 });
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("unknown report producers are not merged just because policy and rule names match", () => {
    const first = report([result("fail", { source: undefined })]);
    const second = report([result("pass", { source: undefined, timestamp: { seconds: 1700000001 } })], {
      metadata: { name: "another-producer", namespace: "apps" }
    });
    expect(analyze([first, second]).findings).toHaveLength(1);
  });
  test("duplicate snapshots select newest resourceVersion without using it as audit time", () => {
    const older = report();
    older.metadata.resourceVersion = "99999999999999999999999";
    const newer = report([result("pass")]);
    newer.metadata.resourceVersion = "100000000000000000000000";
    expect(analyze([older, newer]).findings).toEqual([]);
    expect(analyze([newer, older]).findings).toEqual([]);
    expect(analyze([newer, older]).items).toHaveLength(1);
  });
  test("equal-time conflicts are deterministic and a timestamp-less pass never erases failure", () => {
    const failure = report([result("fail", { severity: "high" })]);
    const pass = report([result("pass", { timestamp: undefined })], { metadata: { name: "pass", namespace: "apps" } });
    expect(analyze([failure, pass]).findings).toHaveLength(1);
    expect(analyze([pass, failure])).toEqual(analyze([failure, pass]));
    const info = report([result("fail", { severity: "info" })], { metadata: { name: "info", namespace: "apps" } });
    expect(analyze([failure, info])).toEqual(analyze([info, failure]));
  });
  test("missing UID and missing API group do not prove an exact current controller identity", () => {
    const workload = raw("custom.io/v1", "Deployment", "web", {}, "apps");
    workload.metadata.uid = "different";
    const input = report([result("fail", { resources: [{ kind: "Deployment", name: "web", namespace: "apps", uid: "reported" }] })]);
    expect(analyze([input], { workloads: [workload] }).findings).toHaveLength(1);
  });
  test("selector results and their report scope never claim a concrete scoped subject", () => {
    const output = analyze([report([result("fail", { resourceSelector: {} })])]);
    expect(output.findings[0].resource.kind).toBe("PolicyReport");
  });
  test("summary-only reports retain reported counts but do not fabricate affected resources or trust", () => {
    const output = analyze([report([], { summary: { fail: 9, pass: 50, error: 2 }, scope: undefined })]);
    expect(output.findings).toEqual([]);
    expect(output.imageTrust).toEqual([]);
    expect(output.items[0].configuration).toMatchObject({ reportedFail: 9, reportedPass: 50, reportedError: 2 });
    expect(output.items[0].evaluatedAt).toBeUndefined();
  });
  test("native validation modes come from matching bindings, never failurePolicy", () => {
    const policy = raw("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "labels", {
      failurePolicy: "Ignore",
      validations: [{ expression: "secret expression" }]
    });
    const binding = raw("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "audit-labels", {
      policyName: "labels",
      validationActions: ["Audit"]
    });
    expect(item(analyze([policy]), "labels").mode).toBe("unbound");
    expect(item(analyze([policy, binding]), "labels")).toMatchObject({
      provider: "native",
      mode: "audit",
      ruleCount: 1,
      configuration: { failurePolicy: "Ignore", bindingCount: 1 }
    });
    expect(item(analyze([policy, binding, raw(binding.apiVersion, binding.kind, "deny-labels", {
      policyName: "labels",
      validationActions: ["Deny", "Audit"]
    })]), "labels").mode).toBe("mixed");
    expect(item(analyze([binding]), "audit-labels").configuration.policyPresent).toBe(false);
  });
  test("native mutation policies use mutation counts and only matching mutation bindings", () => {
    const policy = raw("admissionregistration.k8s.io/v1beta1", "MutatingAdmissionPolicy", "defaults", {
      reinvocationPolicy: "IfNeeded",
      mutations: [{ applyConfiguration: { expression: "hidden" } }]
    });
    const wrong = raw(policy.apiVersion, "ValidatingAdmissionPolicyBinding", "wrong", { policyName: "defaults", validationActions: ["Deny"] });
    expect(item(analyze([policy, wrong]), "defaults").mode).toBe("unbound");
    const binding = raw(policy.apiVersion, "MutatingAdmissionPolicyBinding", "defaults-binding", { policyName: "defaults" });
    expect(item(analyze([policy, binding]), "defaults")).toMatchObject({ mode: "mutate", ruleCount: 1 });
  });
  test("native configuration includes match rules, selectors and parameter references, not parameter data", () => {
    const rules = [{ apiGroups: ["apps"], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["deployments"], scope: "Namespaced" }];
    const output = analyze([
      raw("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "labels", {
        paramKind: { apiVersion: "config.example.com/v1", kind: "LabelConfig", data: "LEAK" },
        matchConstraints: {
          resourceRules: rules,
          excludeResourceRules: [{ apiGroups: [""], resources: ["pods/status"], operations: ["UPDATE"] }],
          namespaceSelector: { matchLabels: { team: "apps", password: "LEAK" } },
          objectSelector: {
            matchExpressions: [{ key: "app", operator: "In", values: ["web"] }]
          }
        },
        validations: [{ expression: "LEAK", message: "LEAK" }]
      }),
      raw("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", "binding", {
        policyName: "labels",
        validationActions: ["Deny"],
        paramRef: {
          name: "labels-config",
          namespace: "apps",
          parameterNotFoundAction: "Deny",
          data: { token: "LEAK" }
        }
      })
    ]);
    expect(item(output, "labels").configuration).toMatchObject({
      paramKind: { apiVersion: "config.example.com/v1", kind: "LabelConfig" },
      matchConstraints: {
        resourceRules: rules,
        namespaceSelector: { matchLabels: { team: "apps" } },
        objectSelector: { matchExpressions: [{ key: "app", operator: "In", values: ["web"] }] }
      }
    });
    expect(item(output, "binding").configuration.paramRef).toEqual({ name: "labels-config", namespace: "apps", parameterNotFoundAction: "Deny" });
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("native webhook metadata includes safe service references, type and rules but no URLs or CA data", () => {
    const webhook = raw("admissionregistration.k8s.io/v1", "ValidatingWebhookConfiguration", "validations");
    webhook.webhooks = [{
      name: "check.example.com",
      failurePolicy: "Fail",
      sideEffects: "None",
      timeoutSeconds: 10,
      clientConfig: { service: { name: "admission", namespace: "policy-system", port: 443, path: "/LEAK" }, caBundle: "LEAK", url: "https://user:LEAK@host" },
      rules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }],
      namespaceSelector: { matchLabels: { team: "apps" } },
      matchConditions: [{ name: "ignore-leases", expression: "LEAK" }]
    }];
    const output = analyze([webhook, { ...webhook, kind: "MutatingWebhookConfiguration" }]);
    expect(output.items).toHaveLength(2);
    expect(output.items.find((entry) => entry.kind === "ValidatingWebhookConfiguration")?.configuration.webhooks).toEqual([
      expect.objectContaining({
        name: "check.example.com",
        type: "validating",
        service: { name: "admission", namespace: "policy-system", port: 443 },
        rules: webhook.webhooks[0].rules,
        namespaceSelector: { matchLabels: { team: "apps" } }
      })
    ]);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("Kyverno rules and exceptions retain explicit match and exclusion references", () => {
    const match = { any: [{ resources: {
      kinds: ["Pod", "apps/v1/Deployment"],
      namespaces: ["apps-*"],
      operations: ["CREATE"],
      selector: { matchLabels: { app: "web" } }
    } }] };
    const policy = raw("kyverno.io/v1", "ClusterPolicy", "labels", { rules: [{
      name: "require",
      match,
      exclude: { any: [{ resources: { namespaces: ["kube-system"] } }] },
      validate: { pattern: { token: "LEAK" } }
    }] });
    const output = analyze([
      policy,
      raw("kyverno.io/v2", "PolicyException", "legacy-exception", { match, exceptions: [{ policyName: "labels", ruleNames: ["require"], token: "LEAK" }] }, "apps"),
      raw("policies.kyverno.io/v1", "PolicyException", "cel-exception", {
        policyRefs: [{ name: "images", kind: "ImageValidatingPolicy", value: "LEAK" }],
        matchConditions: [{ name: "app", expression: "LEAK" }]
      }, "apps")
    ]);
    expect(item(output, "labels").configuration.rules).toEqual([expect.objectContaining({
      name: "require",
      match,
      exclude: { any: [{ resources: { namespaces: ["kube-system"] } }] }
    })]);
    expect(item(output, "legacy-exception").configuration.exceptions).toEqual([{ policyName: "labels", ruleNames: ["require"] }]);
    expect(item(output, "cel-exception").configuration.policyRefs).toEqual([{ name: "images", kind: "ImageValidatingPolicy" }]);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("Gatekeeper matches expose kinds and excluded namespaces without arbitrary parameters", () => {
    const match = {
      kinds: [{ apiGroups: [""], kinds: ["Pod"] }],
      namespaces: ["apps"],
      excludedNamespaces: ["kube-system"],
      labelSelector: { matchLabels: { app: "web" } },
      scope: "Namespaced"
    };
    const output = analyze([raw("constraints.gatekeeper.sh/v1beta1", "CustomRule", "rule", { match, parameters: { token: "LEAK" } })]);
    expect(output.items[0].configuration.match).toEqual(match);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("Kubewarden status enums and transitions are separate from evaluation time and safe member refs", () => {
    const policy = raw("policies.kubewarden.io/v1", "ClusterAdmissionPolicyGroup", "group", {
      mode: "protect",
      policies: { first: { settings: { token: "LEAK" }, module: "LEAK" } },
      rules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }],
      namespaceSelector: { matchLabels: { team: "apps" } }
    });
    policy.status = { policyStatus: "pending", mode: "monitor", conditions: [
      { type: "PolicyActive", status: "False", reason: "LEAK", message: "LEAK", observedGeneration: 3, lastTransitionTime: "2025-01-01T00:00:00Z" },
      { type: "LEAK", status: "True" }
    ] };
    const output = analyze([policy]);
    expect(output.items[0].configuration).toMatchObject({
      memberNames: ["first"],
      observedMode: "monitor",
      policyStatus: "pending",
      rules: policy.spec.rules,
      conditions: [{ type: "PolicyActive", status: "False", observedGeneration: 3, lastTransitionTime: "2025-01-01T00:00:00.000Z" }]
    });
    expect(output.items[0].evaluatedAt).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("Kyverno typed report sources attribute image results without guessing from the policy name", () => {
    const policy = raw("policies.kyverno.io/v1", "ImageValidatingPolicy", "images", { validations: [{ expression: "LEAK" }] });
    const output = analyze([policy, report([result("error", { source: "KyvernoImageValidatingPolicy", policy: "images" })])]);
    expect(output.findings[0].category).toBe("image-trust");
    expect(output.findings[0].result).toBe("error");
    expect(analyze([policy, report([result("fail", { source: "Kyverno", policy: "images" })])]).findings[0].category).toBe("image-trust");
  });
  test("image verification match references and flags are safe, without registry auth or attestor data", () => {
    const output = analyze([
      raw("kyverno.io/v1", "ClusterPolicy", "legacy-images", { rules: [{ name: "verify", verifyImages: [{
        imageReferences: ["registry.example.com/apps/*:stable"],
        required: true,
        verifyDigest: true,
        mutateDigest: false,
        imageRegistryCredentials: { secrets: ["LEAK"] },
        attestors: [{ entries: [{ keys: { publicKeys: "LEAK" } }] }]
      }] }] }),
      raw("policies.kyverno.io/v1", "ImageValidatingPolicy", "images", { matchImageReferences: [
        { glob: "registry.example.com/apps/*" },
        { glob: "https://user:LEAK@registry/images" }
      ] })
    ]);
    expect(item(output, "legacy-images").configuration.rules).toEqual([expect.objectContaining({ verifyImages: [
      expect.objectContaining({ imageReferences: ["registry.example.com/apps/*:stable"], required: true, verifyDigest: true, mutateDigest: false })
    ] })]);
    expect(item(output, "images").configuration.matchImageReferences).toEqual([{ glob: "registry.example.com/apps/*" }]);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("recognizes installed CRDs without inventing policies or treating lookalike groups as providers", () => {
    const crd = raw("apiextensions.k8s.io/v1", "CustomResourceDefinition", "imagevalidatingpolicies.policies.kyverno.io", {
      group: "policies.kyverno.io",
      names: { kind: "ImageValidatingPolicy" }
    });
    const output = analyze([crd, raw("evil.kyverno.io/v1", "ClusterPolicy", "fake")]);
    expect(output.items).toEqual([]);
    expect(output.providers).toContainEqual(expect.objectContaining({ id: "kyverno", itemCount: 0 }));
  });
  test("Kyverno legacy rule modes, overrides, and verifyImages are summarized safely", () => {
    const policy = raw("kyverno.io/v1", "ClusterPolicy", "images", {
      validationFailureAction: "Audit",
      background: false,
      rules: [
        { name: "signed", verifyImages: [{ attestors: [{ entries: [{ keys: { private: "LEAK" } }] }] }] },
        { name: "labels", validate: { failureAction: "Enforce", pattern: { secret: "LEAK" } } }
      ]
    });
    const output = analyze([policy]);
    expect(item(output, "images")).toMatchObject({ provider: "kyverno", mode: "mixed", ruleCount: 2 });
    expect(output.imageTrust).toHaveLength(1);
    expect(output.imageTrust[0].summary).toContain("not verified");
    expect(JSON.stringify(output)).not.toContain("LEAK");
    expect(output.findings.some((entry) => ["pass"].includes(entry.result || ""))).toBe(false);
  });
  test("supports CEL Kyverno policy families, disabled admission, and namespaced image validation", () => {
    const kinds = [
      "ValidatingPolicy",
      "MutatingPolicy",
      "GeneratingPolicy",
      "DeletingPolicy",
      "NamespacedValidatingPolicy",
      "NamespacedMutatingPolicy",
      "NamespacedGeneratingPolicy",
      "NamespacedDeletingPolicy",
      "ImageValidatingPolicy",
      "NamespacedImageValidatingPolicy"
    ];
    const resources = kinds.map((kind) => raw("policies.kyverno.io/v1alpha1", kind, kind.toLowerCase(), {
      validationActions: ["Deny"],
      validations: [{ expression: "LEAK" }],
      credentials: { secrets: ["LEAK"] },
      attestors: [{ cosign: { key: { data: "LEAK" } } }]
    }, kind.startsWith("Namespaced") ? "apps" : ""));
    const output = analyze(resources);
    expect(output.items).toHaveLength(kinds.length);
    expect(output.imageTrust).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain("LEAK");
    resources[0].spec.evaluation = { admission: { enabled: false }, background: { enabled: true } };
    expect(item(analyze(resources), "validatingpolicy").mode).toBe("background");
  });
  test("Gatekeeper templates and arbitrary constraint kinds separate total violations from detail", () => {
    const template = raw("templates.gatekeeper.sh/v1", "ConstraintTemplate", "labels", {
      crd: { spec: { names: { kind: "CompanyLabels" } } },
      targets: [{ rego: "LEAK" }]
    });
    const constraint = raw("constraints.gatekeeper.sh/v1beta1", "CompanyLabels", "required", { enforcementAction: "dryrun", parameters: { token: "LEAK" } });
    constraint.status = {
      auditTimestamp: "2024-01-01T00:00:00Z",
      totalViolations: 27,
      violations: [{ kind: "Pod", name: "web", namespace: "apps", message: "LEAK", enforcementAction: "dryrun" }]
    };
    const output = analyze([template, constraint]);
    expect(item(output, "required")).toMatchObject({
      mode: "audit",
      evaluatedAt: "2024-01-01T00:00:00.000Z",
      configuration: { totalViolations: 27, violationDetailCount: 1, omittedViolationCount: 26 }
    });
    expect(output.findings.filter((entry) => entry.resource.kind === "Pod")).toHaveLength(1);
    expect(output.findings.some((entry) => entry.resource.kind === "CompanyLabels" && entry.message.includes("26"))).toBe(true);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("Gatekeeper zero-detail audit retains a count without claiming 30 concrete resources", () => {
    const constraint = raw("constraints.gatekeeper.sh/v1beta1", "CustomRule", "required");
    constraint.status = { totalViolations: 30, violations: [] };
    const output = analyze([constraint]);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0].resource.kind).toBe("CustomRule");
    expect(output.findings[0].evaluatedAt).toBeUndefined();
  });
  test("Kubewarden groups count member policies, and servers never expose settings or credentials", () => {
    const resources = [
      raw("policies.kubewarden.io/v1", "ClusterAdmissionPolicy", "cluster", { mode: "protect", module: "https://user:LEAK@registry/policy", settings: { token: "LEAK" } }),
      raw("policies.kubewarden.io/v1", "AdmissionPolicy", "local", { mode: "monitor" }, "apps"),
      raw("policies.kubewarden.io/v1", "AdmissionPolicyGroup", "group", { mode: "protect", policies: { a: { settings: "LEAK" }, b: { module: "LEAK" } }, expression: "LEAK" }, "apps"),
      raw("policies.kubewarden.io/v1", "ClusterAdmissionPolicyGroup", "cluster-group", { mode: "monitor", policies: { a: {} } }),
      raw("policies.kubewarden.io/v1", "PolicyServer", "server", { replicas: 2, env: [{ value: "LEAK" }], imagePullSecret: "LEAK" })
    ];
    const output = analyze(resources);
    expect(output.items).toHaveLength(5);
    expect(item(output, "cluster").mode).toBe("enforce");
    expect(item(output, "local").mode).toBe("audit");
    expect(item(output, "group").ruleCount).toBe(2);
    expect(item(output, "server")).toMatchObject({ mode: "server", ruleCount: 0, configuration: { replicas: 2 } });
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("report resources override scope; scope UID is not the report UID", () => {
    const output = analyze([report([result("fail", { resources: [ref("other", "other-uid")] })])]);
    expect(output.findings[0].resource).toEqual({ kind: "Pod", name: "other", namespace: "apps", uid: "other-uid" });
    expect(analyze([report()]).findings[0].resource.uid).toBe("current");
  });
  test("cluster-scoped targets do not inherit the namespaced report namespace", () => {
    const output = analyze([report([result("fail", { resources: [{ apiVersion: "v1", kind: "Namespace", name: "apps", uid: "ns" }] })])]);
    expect(output.findings[0].resource).toEqual({ kind: "Namespace", name: "apps", namespace: "", uid: "ns" });
    expect(output.findings[0].system).toBe(false);
  });
  test("unknown or selector-only report targets stay attributed to the report", () => {
    const output = analyze([report([result("fail", { resourceSelector: { matchLabels: { token: "LEAK" } } })], { scope: undefined })]);
    expect(output.findings[0].resource.kind).toBe("PolicyReport");
    expect(output.findings[0].evidence.join(" ")).toContain("identity");
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("OpenReports report source is inherited, with result source taking precedence", () => {
    const output = analyze([report([
      result("error", { source: undefined }),
      result("fail", { source: "kubewarden", rule: "different" })
    ], { apiVersion: "openreports.io/v1alpha1", kind: "Report", source: "gatekeeper" })]);
    expect(output.findings).toHaveLength(2);
    expect(output.findings.some((entry) => entry.evidence.includes("Source: gatekeeper"))).toBe(true);
    expect(output.findings.some((entry) => entry.evidence.includes("Source: kubewarden"))).toBe(true);
  });
  test("deduplicates report snapshots and cross-format copies by source, rule and target identity", () => {
    const first = report();
    const copy = report([result()], { apiVersion: "openreports.io/v1alpha1", kind: "Report" });
    expect(analyze([first, structuredClone(first), copy]).findings).toHaveLength(1);
    expect(analyze([first, report([result("fail", { source: "kubewarden" })], { metadata: { name: "other" } })]).findings).toHaveLength(2);
  });
  test("newer evaluated pass replaces an older failure; fetch metadata never determines evaluation time", () => {
    const newer = report([result("pass", { timestamp: { seconds: 1700000001 } })], { metadata: { name: "new", namespace: "apps" } });
    expect(analyze([report(), newer]).findings).toEqual([]);
    const noTime = report([result("fail", { timestamp: undefined })]);
    noTime.metadata.creationTimestamp = "2025-01-01T00:00:00Z";
    noTime.metadata.managedFields = [{ time: "2025-01-02T00:00:00Z" }];
    noTime.fetchedAt = "2025-01-03T00:00:00Z";
    expect(analyze([noTime]).findings[0].evaluatedAt).toBeUndefined();
    expect(item(analyze([noTime]), "report").evaluatedAt).toBeUndefined();
  });
  test("report fail, error, warn and skip retain different semantics and pass is not a trust success", () => {
    const output = analyze([report(["fail", "error", "warn", "skip", "pass"].map((outcome) => result(outcome, { rule: outcome, severity: "critical" })))]);
    expect(output.findings).toHaveLength(4);
    expect(output.findings.find((entry) => entry.result === "fail")?.severity).toBe("critical");
    expect(output.findings.find((entry) => entry.result === "error")).toMatchObject({ severity: "warning", title: "Policy evaluation error" });
    expect(output.findings.find((entry) => entry.result === "skip")).toMatchObject({ severity: "info", title: "Policy evaluation skipped" });
    expect(output.imageTrust).toEqual([]);
  });
  test("drops old UIDs and known terminating resources but retains absent scoped resources as unverified", () => {
    expect(analyze([report()], { pods: [pod("web", "replacement")] }).findings).toEqual([]);
    expect(analyze([report()], { pods: [] }).findings[0].evidence.join(" ")).toContain("unverified");
    const terminating = pod();
    terminating.metadata.deletionTimestamp = "2025-01-01T00:00:00Z";
    expect(analyze([report()], { pods: [terminating] }).findings).toEqual([]);
    expect(analyze([report()]).findings).toHaveLength(1);
    expect(analyze([report()], { pods: [pod()] }).findings).toHaveLength(1);
  });
  test("complete Pod inventory suppresses proven missing targets only inside its namespace scope", () => {
    const input = report([result("fail", { resources: [ref(), ref("other", "outside", "other")] })]);
    const output = analyze([input], { pods: [], inventoryComplete: { Pod: true }, namespaceScope: "apps" });
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0].resource.namespace).toBe("other");
    expect(output.findings[0].evidence.join(" ")).toContain("unverified");
    expect(output.items[0].configuration.missingResourceResultCount).toBe(1);
    expect(analyze([input], { pods: [], inventoryComplete: { Pod: true }, namespaceScope: null }).findings).toEqual([]);
  });
  test("missing suppression requires explicitly complete available inventory and respects exact API groups", () => {
    for (const inventoryComplete of [undefined, { Pod: false }, { Pod: "true" }]) {
      expect(analyze([report()], { pods: [], inventoryComplete, namespaceScope: "apps" }).findings).toHaveLength(1);
    }
    expect(analyze([report()], { inventoryComplete: { Pod: true }, namespaceScope: "apps" }).findings).toHaveLength(1);
    const unknown = report([result("fail", { resources: [{ apiVersion: "custom.io/v1", kind: "Pod", name: "custom", namespace: "apps" }] })]);
    expect(analyze([unknown], { pods: [], inventoryComplete: { Pod: true }, namespaceScope: "apps" }).findings).toHaveLength(1);
  });
  test("complete Namespace and controller inventories do not erase unrelated kinds or out-of-scope subjects", () => {
    const refs = [
      { apiVersion: "v1", kind: "Namespace", name: "apps" },
      { apiVersion: "v1", kind: "Namespace", name: "other" },
      { apiVersion: "apps/v1", kind: "Deployment", name: "deleted", namespace: "apps" },
      { apiVersion: "v1", kind: "Service", name: "unknown", namespace: "apps" }
    ];
    const output = analyze([report([result("fail", { resources: refs })])], {
      namespaces: [],
      workloads: [],
      inventoryComplete: { Namespace: true, Deployment: true, Service: true },
      namespaceScope: "apps"
    });
    expect(output.findings.map((entry) => entry.resource.name).sort()).toEqual(["other", "unknown"]);
    expect(output.findings.every((entry) => entry.evidence.join(" ").includes("unverified"))).toBe(true);
  });
  test("complete inventory suppresses missing Gatekeeper details without changing the reported audit total", () => {
    const constraint = raw("constraints.gatekeeper.sh/v1beta1", "CustomRule", "rule");
    constraint.status = { totalViolations: 1, violations: [{ group: "", kind: "Pod", name: "deleted", namespace: "apps" }] };
    const output = analyze([constraint], { pods: [], inventoryComplete: { Pod: true }, namespaceScope: "apps" });
    expect(output.findings).toEqual([]);
    expect(output.items[0].configuration).toMatchObject({ totalViolations: 1, violationDetailCount: 1, staleDetailCount: 1 });
  });
  test("equal outcomes prefer a known evaluation timestamp deterministically", () => {
    const dated = report();
    const undated = report([result("fail", { timestamp: undefined })], { metadata: { name: "undated", namespace: "apps" } });
    expect(analyze([dated, undated])).toEqual(analyze([undated, dated]));
    expect(analyze([undated, dated]).findings[0].evaluatedAt).toBe("2023-11-14T22:13:20.000Z");
  });
  test("workload inventory detects exact replacements without treating absent controllers as deleted", () => {
    const target = { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "apps", uid: "old" };
    const input = report([result("fail", { resources: [target] })]);
    const replacement = raw("apps/v1", "Deployment", "web", {}, "apps");
    replacement.metadata.uid = "new";
    expect(analyze([input], { workloads: [replacement] }).findings).toEqual([]);
    expect(analyze([input], { workloads: [] }).findings[0].evidence.join(" ")).toContain("unverified");
    expect(analyze([input], { workloads: [{ ...replacement, apiVersion: "other.io/v1" }] }).findings).toHaveLength(1);
  });
  test("UID-only references resolve only against matching known objects", () => {
    const input = report([result("fail", { resources: [{ uid: "current" }] })]);
    expect(analyze([input], { pods: [pod()] }).findings[0].resource).toEqual({ kind: "Pod", name: "web", namespace: "apps", uid: "current" });
    expect(analyze([input]).findings[0].resource.kind).toBe("PolicyReport");
  });
  test("old UID-less audits cannot apply to objects created after evaluation", () => {
    const current = pod();
    current.metadata.creationTimestamp = "2025-01-01T00:00:00Z";
    expect(analyze([report([result("fail", { resources: [{ kind: "Pod", name: "web", namespace: "apps" }] })])], { pods: [current] }).findings).toEqual([]);
  });
  test("same names in distinct namespaces and API groups never collapse", () => {
    const output = analyze([report([result("fail", { resources: [
      ref(),
      ref("web", "second", "other"),
      { apiVersion: "custom.io/v1", kind: "Pod", name: "web", namespace: "apps", uid: "third" }
    ] })])]);
    expect(output.findings).toHaveLength(3);
    expect(new Set(output.findings.map((entry) => entry.id)).size).toBe(3);
  });
  test("image results require a matching image rule, not an image-sounding policy name", () => {
    const policy = raw("kyverno.io/v1", "ClusterPolicy", "images", { rules: [
      { name: "signed", verifyImages: [{}] },
      { name: "labels", validate: {} }
    ] });
    const output = analyze([policy, report([
      result("fail", { policy: "images", rule: "signed" }),
      result("fail", { policy: "images", rule: "labels" }),
      result("pass", { policy: "signed-images", rule: "verify" })
    ])]);
    expect(output.findings.find((entry) => entry.evidence.includes("Rule: signed"))?.category).toBe("image-trust");
    expect(output.findings.find((entry) => entry.evidence.includes("Rule: labels"))?.category).toBe("admission");
  });
  test("malformed scalar configuration and arbitrary report messages/properties do not escape", () => {
    const output = analyze([
      raw("policies.kubewarden.io/v1", "AdmissionPolicy", "safe", { mode: { token: "LEAK" }, policyServer: { token: "LEAK" }, failurePolicy: "LEAK" }),
      report([result("fail", { message: "password=LEAK", properties: { credential: "LEAK" }, severity: { secret: "LEAK" } })])
    ]);
    expect(JSON.stringify(output)).not.toContain("LEAK");
  });
  test("system classification uses the target, not the controller/report namespace", () => {
    const output = analyze([report([result("fail", { resources: [ref("dns", "dns-uid", "kube-system"), ref()] })], {
      metadata: { name: "report", namespace: "kube-system" }
    })]);
    expect(output.findings.find((entry) => entry.resource.name === "dns")?.system).toBe(true);
    expect(output.findings.find((entry) => entry.resource.name === "web")?.system).toBe(false);
  });
  test("is deterministic, non-mutating, and stable under resource ordering", () => {
    const resources = [report(), raw("policies.kubewarden.io/v1", "AdmissionPolicy", "local", { mode: "monitor" }, "apps")];
    const before = JSON.stringify(resources);
    const first = analyze(resources);
    expect(analyze([...resources].reverse())).toEqual(first);
    expect(JSON.stringify(resources)).toBe(before);
  });
});
