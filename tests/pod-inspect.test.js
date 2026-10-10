import { describe, expect, test } from "bun:test";
import { buildObjectInspect, buildPodInspect, inspectObjectPaths, sanitizePodManifest } from "../src/shared/pod-inspect.js";
const pod = {
  metadata: {
    name: "api-6d9f7c8b5-x2kqp",
    namespace: "kubi-saas",
    managedFields: [{ manager: "kubectl" }],
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"secret":1}', keep: "yes" }
  },
  spec: {
    nodeName: "kubi-saas",
    serviceAccountName: "api",
    containers: [{
      name: "api",
      image: "api:1",
      ports: [{ containerPort: 8080, name: "http" }],
      env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "TOKEN", valueFrom: { secretKeyRef: { name: "api", key: "token" } } }],
      resources: { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
      readinessProbe: { httpGet: { port: 8080 } }
    }]
  },
  status: {
    podIP: "10.42.0.7",
    qosClass: "Burstable",
    conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
    containerStatuses: [{ name: "api", ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }]
  }
};
describe("pod inspect", () => {
  test("redacts literal env values and drops managed fields", () => {
    const clean = sanitizePodManifest(pod);
    expect(clean.metadata.managedFields).toBeUndefined();
    expect(clean.metadata.annotations).toEqual({ keep: "yes" });
    expect(clean.spec.containers[0].env[0].value).toBe("<redacted by KUBI>");
    expect(clean.spec.containers[0].env[1].valueFrom.secretKeyRef.name).toBe("api");
    expect(pod.spec.containers[0].env[0].value).toBe("hunter2");
  });
  test("summarizes containers, conditions and events without secret values", () => {
    const result = buildPodInspect({
      pod,
      events: [
        { type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 4, lastTimestamp: "2026-10-08T10:00:00Z" },
        { type: "Normal", reason: "Pulled", message: "Pulled image", count: 1, lastTimestamp: "2026-10-08T09:00:00Z" }
      ]
    });
    expect(result.containers[0]).toMatchObject({ name: "api", state: "CrashLoopBackOff", restartCount: 3, lastTermination: { reason: "OOMKilled", exitCode: 137 }, probes: ["readinessProbe"], ports: ["8080/TCP http"] });
    expect(result.events[0].reason).toBe("BackOff");
    expect(result.manifest).not.toContain("hunter2");
    expect(result.manifest).toContain("CrashLoopBackOff");
  });
});
describe("object inspect", () => {
  test("allows only listed kinds and validates names", () => {
    expect(inspectObjectPaths({ kind: "Job", namespace: "apps", name: "backup-1" })).toEqual({
      object: "/apis/batch/v1/namespaces/apps/jobs/backup-1",
      events: "/api/v1/namespaces/apps/events?fieldSelector=involvedObject.kind%3DJob%2CinvolvedObject.name%3Dbackup-1"
    });
    expect(inspectObjectPaths({ kind: "StorageClass", name: "fast" }).object).toBe("/apis/storage.k8s.io/v1/storageclasses/fast");
    expect(() => inspectObjectPaths({ kind: "Secret", namespace: "apps", name: "db" })).toThrow();
    expect(() => inspectObjectPaths({ kind: "toString", namespace: "apps", name: "db" })).toThrow();
    expect(() => inspectObjectPaths({ kind: "Job", namespace: "apps", name: "../x" })).toThrow();
    expect(() => inspectObjectPaths({ kind: "Job", name: "x" })).toThrow();
  });
  test("redacts literal env values in CronJob templates and keeps conditions", () => {
    const cronJob = {
      kind: "CronJob",
      metadata: { name: "db-backup", namespace: "apps", managedFields: [{}] },
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "backup", env: [{ name: "PASSWORD", value: "hunter2" }, { name: "REF", valueFrom: { secretKeyRef: { name: "s", key: "k" } } }] }] } } } } },
      status: { conditions: [{ type: "Complete", status: "True" }] }
    };
    const result = buildObjectInspect({ kind: "CronJob", object: cronJob, events: [{ reason: "SawCompletedJob", message: "done", lastTimestamp: "2026-10-09T01:00:00Z" }] });
    expect(result.manifest).not.toContain("hunter2");
    expect(result.manifest).not.toContain("managedFields");
    expect(result.manifest).toContain("secretKeyRef");
    expect(result.conditions).toEqual([expect.objectContaining({ type: "Complete", status: "True" })]);
    expect(result.events[0]).toMatchObject({ reason: "SawCompletedJob", count: 1 });
  });
});
