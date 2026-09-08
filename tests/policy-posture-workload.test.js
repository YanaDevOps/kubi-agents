import { describe, expect, test } from "bun:test";
import { analyzeWorkloadPosture } from "../src/shared/policy-posture-workload.js";
function pod(name = "web", spec = {}, namespace = "apps") {
  return {
    kind: "Pod",
    metadata: { name, namespace, uid: `${namespace}-${name}` },
    spec: { containers: [{ name: "web" }], ...spec }
  };
}
function workload(kind, name, spec = {}) {
  const template = { metadata: {}, spec: pod(name, spec).spec };
  return {
    kind,
    metadata: { name, namespace: "apps" },
    spec: kind === "CronJob" ? { jobTemplate: { spec: { template } } } : { template }
  };
}
function namespace(labels = {}, name = "apps") {
  return { kind: "Namespace", metadata: { name, labels } };
}
function analyze(pods, workloads = [], kubernetesVersion = "v1.34.1") {
  return analyzeWorkloadPosture({ pods, workloads, namespaces: [], kubernetesVersion });
}
function rules(result) {
  return result.findings.map((finding) => finding.id.split(":")[1]);
}
const hardened = {
  runAsNonRoot: true,
  runAsUser: 1000,
  seccompProfile: { type: "RuntimeDefault" },
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] }
};
describe("workload policy posture", () => {
  test("accepts empty and malformed inventories without manufacturing resources", () => {
    const result = analyzeWorkloadPosture({ pods: [null, {}, []], workloads: [], namespaces: [] });
    expect(result.findings).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.coverage.assessedResources).toBe(0);
    expect(result.coverage.versionAssumed).toBe(true);
  });
  test("does not mislabel missing hardening as Baseline violations", () => {
    const result = analyze([pod()]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((finding) => finding.title.startsWith("Hardening:"))).toBe(true);
    expect(rules(result)).toContain("hardening-seccomp");
    expect(result.findings.some((finding) => /runs as root/i.test(finding.message))).toBe(false);
    expect(analyze([pod("safe", { containers: [{ name: "web", securityContext: hardened }] })]).findings).toEqual([]);
  });
  for (const field of ["containers", "initContainers", "ephemeralContainers"]) {
    test(`checks Baseline violations in ${field}`, () => {
      const result = analyze([pod("unsafe", { [field]: [{
        name: "unsafe",
        securityContext: { privileged: true, capabilities: { add: ["SYS_ADMIN"] }, procMount: "Unmasked" },
        ports: [{ hostPort: 8080 }]
      }] })]);
      expect(rules(result)).toEqual(expect.arrayContaining([
        "baseline-privileged",
        "baseline-capabilities",
        "baseline-proc-mount",
        "baseline-host-port"
      ]));
      const finding = result.findings.find((entry) => entry.id.includes(":baseline-privileged:"));
      expect(finding).toMatchObject({
        category: "workload",
        severity: "critical",
        system: false,
        resource: { kind: "Pod", name: "unsafe", namespace: "apps", uid: "apps-unsafe" }
      });
      expect(finding.evidence.some((entry) => entry.includes(`${field}[unsafe]`))).toBe(true);
      expect(finding.recommendation.length).toBeGreaterThan(0);
    });
  }
  test("checks host namespaces and hostPath, but permits hostPort zero and Baseline capabilities", () => {
    const result = analyze([pod("host", {
      hostNetwork: true,
      hostPID: true,
      hostIPC: true,
      volumes: [{ name: "host", hostPath: { path: "/" } }],
      containers: [{ name: "web", ports: [{ hostPort: 0 }], securityContext: { capabilities: { add: ["CHOWN", "NET_BIND_SERVICE"] } } }]
    })]);
    expect(rules(result)).toContain("baseline-host-namespaces");
    expect(rules(result)).toContain("baseline-host-path");
    expect(rules(result)).not.toContain("baseline-host-port");
    expect(rules(result)).not.toContain("baseline-capabilities");
  });
  test("inherits only supported pod security fields and honors container overrides", () => {
    const inherited = pod("inherited", { securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" }
    }, containers: [{ name: "web", securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] }
    } }] });
    expect(analyze([inherited]).findings).toEqual([]);
    inherited.spec.containers[0].securityContext.runAsNonRoot = false;
    inherited.spec.containers[0].securityContext.runAsUser = 0;
    inherited.spec.containers[0].securityContext.seccompProfile = { type: "Unconfined" };
    expect(rules(analyze([inherited]))).toEqual(expect.arrayContaining(["hardening-non-root", "baseline-seccomp"]));
    const invalidInheritance = pod("invalid", { securityContext: hardened });
    expect(rules(analyze([invalidInheritance]))).toEqual(expect.arrayContaining([
      "hardening-privilege-escalation",
      "hardening-read-only-root",
      "hardening-drop-capabilities"
    ]));
  });
  test("checks forbidden pod-level settings even when containers override them", () => {
    const result = analyze([pod("override", {
      securityContext: {
        seccompProfile: { type: "Unconfined" },
        appArmorProfile: { type: "Unconfined" },
        seLinuxOptions: { user: "root", role: "system_r", type: "spc_t" }
      },
      containers: [{ name: "web", securityContext: hardened }]
    })]);
    expect(rules(result)).toEqual(expect.arrayContaining(["baseline-seccomp", "baseline-apparmor", "baseline-selinux"]));
  });
  test("checks template AppArmor annotations, including safe localhost profiles", () => {
    const deploy = workload("Deployment", "web");
    deploy.spec.template.metadata.annotations = { "container.apparmor.security.beta.kubernetes.io/web": "unconfined" };
    expect(rules(analyze([], [deploy]))).toContain("baseline-apparmor");
    deploy.spec.template.metadata.annotations["container.apparmor.security.beta.kubernetes.io/web"] = "localhost/custom";
    expect(rules(analyze([], [deploy]))).not.toContain("baseline-apparmor");
    deploy.spec.template.metadata.annotations["container.apparmor.security.beta.kubernetes.io/web"] = "";
    expect(rules(analyze([], [deploy]))).not.toContain("baseline-apparmor");
  });
  test("does not impose Linux hardening on Windows, but checks HostProcess at either scope", () => {
    expect(analyze([pod("win", { os: { name: "windows" } })]).findings).toEqual([]);
    const win = pod("win", {
      os: { name: "windows" },
      securityContext: { windowsOptions: { hostProcess: true } },
      ephemeralContainers: [{ name: "debug", securityContext: { windowsOptions: { hostProcess: true } } }]
    });
    const result = analyze([win]);
    expect(rules(result)).toContain("baseline-host-process");
    expect(result.findings[0].evidence.join(" ")).toContain("ephemeralContainers[debug]");
    expect(rules(analyze([pod("linux", { nodeSelector: { "kubernetes.io/os": "windows" } })]))).toContain("hardening-seccomp");
  });
  test("gates safe sysctls, SELinux types and host probes by Kubernetes version", () => {
    const raw = pod("versions", {
      securityContext: {
        seLinuxOptions: { type: "container_engine_t" },
        sysctls: [{ name: "net.ipv4.tcp_keepalive_time", value: "30" }, { name: "net.ipv4.ip_local_reserved_ports", value: "3000" }]
      },
      containers: [{
        name: "web",
        livenessProbe: { httpGet: { host: "127.0.0.1", port: 80 } },
        lifecycle: { preStop: { tcpSocket: { host: "host.internal", port: 80 } } }
      }]
    });
    expect(rules(analyze([raw], [], "v1.26.10"))).toEqual(expect.arrayContaining(["baseline-sysctls", "baseline-selinux"]));
    expect(rules(analyze([raw], [], "v1.30.0"))).not.toContain("baseline-sysctls");
    expect(rules(analyze([raw], [], "v1.31.0"))).not.toContain("baseline-selinux");
    expect(rules(analyze([raw], [], "v1.33.9"))).not.toContain("baseline-host-probes");
    expect(rules(analyze([raw], [], "v1.34.1+k3s1"))).toContain("baseline-host-probes");
    raw.spec.securityContext.sysctls.push({ name: "kernel.core_pattern", value: "core" });
    expect(rules(analyze([raw]))).toContain("baseline-sysctls");
  });
  test("accepts TCP buffer sysctls only from 1.32 and uses exact PSS allowlist names", () => {
    const raw = pod("sysctls", { securityContext: { sysctls: [
      { name: "net.ipv4.tcp_rmem", value: "4096 131072 6291456" },
      { name: "net.ipv4.tcp_wmem", value: "4096 16384 4194304" }
    ] } });
    expect(rules(analyze([raw], [], "v1.31.0"))).toContain("baseline-sysctls");
    expect(rules(analyze([raw], [], "v1.32.0"))).not.toContain("baseline-sysctls");
    raw.spec.securityContext.sysctls = [{ name: "net/ipv4/tcp_syncookies", value: "1" }];
    expect(rules(analyze([raw]))).toContain("baseline-sysctls");
  });
  test("excludes terminal pods/jobs and only inactive owned historical ReplicaSets", () => {
    const done = pod("done");
    done.status = { phase: "Succeeded" };
    const failed = pod("failed");
    failed.status = { phase: "Failed" };
    const job = workload("Job", "done-job");
    job.status = { conditions: [{ type: "Complete", status: "True" }] };
    const failedJob = workload("Job", "failed-job");
    failedJob.status = { conditions: [{ type: "Failed", status: "True" }] };
    const old = workload("ReplicaSet", "old");
    old.spec.replicas = 0;
    old.metadata.ownerReferences = [{ kind: "Deployment", name: "web", controller: true }];
    expect(analyze([done, failed], [job, failedJob, old]).items).toEqual([]);
    const standalone = workload("ReplicaSet", "standalone");
    standalone.spec.replicas = 0;
    const active = structuredClone(old);
    active.metadata.name = "active";
    active.spec.replicas = 1;
    const livePod = pod("still-running");
    livePod.metadata.ownerReferences = [{ kind: "ReplicaSet", name: "old", controller: true }];
    expect(analyze([livePod], [old, standalone, active]).coverage.assessedResources).toBe(4);
  });
  for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet", "ReplicationController"]) {
    test(`reads the ${kind} pod template`, () => {
      expect(rules(analyze([], [workload(kind, "web", { hostPID: true })]))).toContain("baseline-host-namespaces");
    });
  }
  test("deduplicates security configurations, retains affected resources, and is deterministic and pure", () => {
    const input = {
      pods: [pod("web-2", { hostPID: true }), pod("web-1", { hostPID: true })],
      workloads: [workload("Deployment", "web", { hostPID: true })],
      namespaces: [],
      kubernetesVersion: "v1.34.0"
    };
    for (const raw of input.pods)
      raw.metadata.ownerReferences = [{ kind: "Deployment", name: "web", controller: true }];
    const before = structuredClone(input);
    const result = analyzeWorkloadPosture(input);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].affectedResources).toHaveLength(3);
    expect(result.items[0].resource.kind).toBe("Deployment");
    expect(result.coverage.assessedResources).toBe(3);
    expect(result.coverage.uniqueConfigurations).toBe(1);
    expect(result.findings.filter((entry) => entry.id.includes(":baseline-host-namespaces:"))).toHaveLength(1);
    expect(result.findings[0].evidence.join(" ")).toContain("web-2");
    expect(analyzeWorkloadPosture({ ...input, pods: [...input.pods].reverse() })).toEqual(result);
    expect(input).toEqual(before);
    input.pods.push(pod("different", { hostIPC: true }), pod("system", { hostPID: true }, "kube-system"));
    const changed = analyzeWorkloadPosture(input);
    expect(changed.items).toHaveLength(3);
    expect(changed.findings.filter((entry) => entry.resource.namespace === "kube-system").every((entry) => entry.system)).toBe(true);
  });
  test("keeps unrelated workloads and standalone pods distinct even with identical configurations", () => {
    const result = analyze([pod("one"), pod("two")], [workload("Deployment", "alpha"), workload("Deployment", "beta")]);
    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => item.affectedResources.length === 1)).toBe(true);
  });
  test("resolves controller UID lineage through ReplicaSets and retains differing active revisions", () => {
    const deploy = workload("Deployment", "web");
    deploy.metadata.uid = "deploy-current";
    const rs = workload("ReplicaSet", "web-rs");
    rs.metadata.uid = "rs-current";
    rs.spec.replicas = 2;
    rs.metadata.ownerReferences = [{ kind: "Deployment", name: "web", uid: "deploy-current", controller: true }];
    const one = pod("one");
    const two = pod("two");
    for (const raw of [one, two])
      raw.metadata.ownerReferences = [{ kind: "ReplicaSet", name: "web-rs", uid: "rs-current", controller: true }];
    const result = analyze([one, two], [rs, deploy]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].lineage).toMatchObject({ kind: "Deployment", name: "web", uid: "deploy-current" });
    expect(result.items[0].affectedResources).toHaveLength(4);
    two.spec.hostPID = true;
    expect(analyze([one, two], [rs, deploy]).items).toHaveLength(2);
    one.metadata.ownerReferences[0].uid = "rs-replaced";
    const changed = analyze([one, two], [rs, deploy]);
    expect(changed.items).toHaveLength(3);
    expect(changed.items.find((item) => item.resource.name === "one")?.lineage.uid).toBe("rs-replaced");
  });
  test("terminates malformed cyclic controller chains even when owner references omit UIDs", () => {
    const first = workload("Deployment", "first");
    first.metadata.uid = "first-uid";
    const second = workload("ReplicaSet", "second");
    second.metadata.uid = "second-uid";
    first.metadata.ownerReferences = [{ kind: "ReplicaSet", name: "second", controller: true }];
    second.metadata.ownerReferences = [{ kind: "Deployment", name: "first", controller: true }];
    expect(analyze([], [first, second]).coverage.assessedResources).toBe(2);
  });
  test("exposes namespace PSA modes and pins Baseline assessment to a declared enforce version", () => {
    const result = analyzeWorkloadPosture({ pods: [pod("web", {
      securityContext: { seLinuxOptions: { type: "container_engine_t" } },
      containers: [{ name: "web", livenessProbe: { httpGet: { host: "127.0.0.1", port: 80 } } }]
    })], namespaces: [namespace({
      "pod-security.kubernetes.io/enforce": "baseline",
      "pod-security.kubernetes.io/enforce-version": "v1.30"
    })], kubernetesVersion: "v1.34.1" });
    expect(result.items[0].namespacePolicy).toMatchObject({
      namespace: "apps",
      observed: true,
      enforce: { level: "baseline", declared: true, version: "v1.30", referenceVersion: "v1.30", versionAssumed: false },
      audit: { level: "unknown", declared: false },
      warn: { level: "unknown", declared: false }
    });
    expect(result.items[0].baselineVersions).toEqual(["v1.30"]);
    expect(rules(result)).toContain("baseline-selinux");
    expect(rules(result)).not.toContain("baseline-host-probes");
    expect(result.findings.find((finding) => finding.id.includes("baseline-selinux"))?.evidence.join(" ")).toContain("enforce=baseline");
  });
  test("absent PSA labels are unknown rather than proof that admission is disabled", () => {
    const known = analyzeWorkloadPosture({ pods: [pod()], namespaces: [namespace()], kubernetesVersion: "v1.34.0" });
    const missing = analyze([pod()]);
    expect(known.items[0].namespacePolicy).toMatchObject({ observed: true, enforce: { level: "unknown", declared: false } });
    expect(missing.items[0].namespacePolicy).toMatchObject({ observed: false, enforce: { level: "unknown", declared: false } });
    expect(known.coverage.namespacePolicies[0].notes.join(" ")).toContain("defaults");
    expect(known.findings.some((finding) => finding.id.includes("restricted-"))).toBe(false);
  });
  for (const mode of ["enforce", "audit", "warn"]) {
    test(`separates Restricted requirements declared by namespace ${mode} from optional hardening`, () => {
      const result = analyzeWorkloadPosture({ pods: [pod()], namespaces: [namespace({
        [`pod-security.kubernetes.io/${mode}`]: "restricted",
        [`pod-security.kubernetes.io/${mode}-version`]: "v1.30"
      })], kubernetesVersion: "v1.34.0" });
      expect(rules(result)).toEqual(expect.arrayContaining([
        "restricted-non-root",
        "restricted-seccomp",
        "restricted-privilege-escalation",
        "restricted-drop-capabilities",
        "hardening-read-only-root"
      ]));
      expect(rules(result)).not.toContain("hardening-seccomp");
      expect(result.items[0].restrictedViolations).toBe(4);
      expect(result.findings.filter((finding) => finding.id.includes(":restricted-")).every((finding) => finding.title.startsWith("PSS Restricted:") && finding.message.includes(mode) && !finding.message.includes("Optional"))).toBe(true);
      expect(result.coverage.restrictedAssessment).toBe("implemented-checks-only");
    });
  }
  test("evaluates different declared mode versions without treating warn/audit as enforce", () => {
    const result = analyzeWorkloadPosture({ pods: [pod("web", { containers: [{
      name: "web",
      livenessProbe: { httpGet: { host: "host.internal", port: 80 } }
    }] })], namespaces: [namespace({
      "pod-security.kubernetes.io/enforce": "baseline",
      "pod-security.kubernetes.io/enforce-version": "v1.30",
      "pod-security.kubernetes.io/audit": "restricted",
      "pod-security.kubernetes.io/audit-version": "v1.34",
      "pod-security.kubernetes.io/warn": "restricted",
      "pod-security.kubernetes.io/warn-version": "v1.32"
    })], kubernetesVersion: "v1.34.1" });
    expect(result.items[0].baselineVersions).toEqual(["v1.30", "v1.32", "v1.34"]);
    const probes = result.findings.find((finding) => finding.id.includes("baseline-host-probes"));
    expect(probes.evidence.join(" ")).toContain("audit=restricted");
    expect(probes.evidence.join(" ")).not.toContain("enforce=baseline");
  });
  test("uses versioned Windows exemptions for declared Restricted and retains pod-level constraints", () => {
    const raw = pod("win", { os: { name: "windows" }, securityContext: { runAsNonRoot: true } });
    const analyzeVersion = (version) => analyzeWorkloadPosture({ pods: [raw], namespaces: [namespace({
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/enforce-version": version
    })], kubernetesVersion: "v1.34.0" });
    expect(rules(analyzeVersion("v1.24"))).toEqual(expect.arrayContaining(["restricted-seccomp", "restricted-drop-capabilities", "restricted-privilege-escalation"]));
    expect(analyzeVersion("v1.25").findings).toEqual([]);
    raw.spec.securityContext.runAsNonRoot = false;
    raw.spec.containers[0].securityContext = { runAsNonRoot: true };
    expect(rules(analyzeVersion("v1.30"))).toContain("restricted-non-root");
  });
  test("signals unsupported Kubernetes 1.36 visibly even when a namespace pins a supported PSA reference", () => {
    const result = analyzeWorkloadPosture({
      pods: [pod("safe", { containers: [{ name: "web", securityContext: hardened }] })],
      namespaces: [namespace({ "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "v1.30" })],
      kubernetesVersion: "v1.36.2"
    });
    expect(result.coverage).toMatchObject({
      partial: true,
      status: "partial",
      versionAssumed: true,
      requestedVersion: "v1.36.2",
      supportedVersionRange: "v1.23-v1.34"
    });
    expect(result.findings.find((finding) => finding.id.includes("version-coverage"))).toMatchObject({ severity: "info", category: "workload" });
    expect(result.findings.find((finding) => finding.id.includes("version-coverage"))?.message).toContain("v1.36.2");
    expect(result.items[0].namespacePolicy.enforce.referenceVersion).toBe("v1.30");
    expect(result.items[0].namespacePolicy.enforce.versionAssumed).toBe(false);
  });
  test("marks unsupported and malformed namespace PSA versions as partial rather than silently accepting them", () => {
    for (const version of ["v1.36", "not-a-version", "v1.30.1"]) {
      const result = analyzeWorkloadPosture({ pods: [pod()], namespaces: [namespace({
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": version
      })], kubernetesVersion: "v1.34.0" });
      expect(result.coverage.partial).toBe(true);
      expect(result.items[0].namespacePolicy.enforce.versionAssumed).toBe(true);
      expect(result.findings.some((finding) => finding.id.includes("namespace-version-coverage"))).toBe(true);
    }
  });
});
