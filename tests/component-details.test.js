import { describe, expect, test } from "bun:test";
import { collectComponentDetails } from "../src/shared/component-details.js";
import { METADATA_ACCEPT } from "../src/shared/namespace-summary.js";
describe("component details", () => {
  test("counts CRD objects with metadata-only limit=1 lists and reads workload versions", async () => {
    const calls = [];
    const result = await collectComponentDetails({
      request: async (path, settings) => {
        calls.push([path, settings?.accept]);
        if (path.startsWith("/apis/apiextensions"))
          return { items: [
            { metadata: { name: "certificates.cert-manager.io" }, spec: { group: "cert-manager.io", scope: "Namespaced", names: { plural: "certificates" }, versions: [{ name: "v1", storage: true }] } },
            { metadata: { name: "broken.example.io" }, spec: { group: "example.io", names: { plural: "broken" }, versions: [{ name: "v1", storage: true }] } }
          ] };
        if (path.startsWith("/apis/cert-manager.io/v1/certificates"))
          return { items: [{}], metadata: { remainingItemCount: 12 } };
        if (path.startsWith("/apis/example.io"))
          throw new Error("HTTP 403");
        if (path === "/apis/apps/v1/deployments")
          return { items: [{ metadata: { name: "traefik", namespace: "kube-system" }, spec: { replicas: 1, template: { spec: { containers: [{ image: "rancher/mirrored-library-traefik:3.3.2" }] } } }, status: { readyReplicas: 1 } }] };
        return { items: [] };
      }
    });
    expect(result.crdCounts).toEqual({ "certificates.cert-manager.io": 13, "broken.example.io": null });
    expect(calls.find(([path]) => path.startsWith("/apis/cert-manager.io"))).toEqual(["/apis/cert-manager.io/v1/certificates?limit=1", METADATA_ACCEPT]);
    expect(result.workloads["kube-system/deployment/traefik"]).toEqual({ ready: 1, desired: 1, version: "3.3.2" });
  });
});
