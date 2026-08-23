# Delivery Activity

KUBI Agent reads delivery state from Kubernetes APIs through the selected kubeconfig. The hosted service receives normalized status and metadata, not repository credentials, Kubernetes Secret values, or raw kubeconfigs.

## Native coverage

- Argo CD: Applications, ApplicationSets, AppProjects, all source references, health, structured sync policy, project consumers, destinations, resource rules, roles, and sync windows.
- Flux: Kustomizations, HelmReleases, source objects, and ImageUpdateAutomations.
- Tekton: Pipelines, Tasks, PipelineRuns, and TaskRuns.
- Argo Workflows: Workflows, CronWorkflows, WorkflowTemplates, and ClusterWorkflowTemplates.
- Argo Rollouts: Rollouts, AnalysisRuns, AnalysisTemplates, and ClusterAnalysisTemplates.
- Flagger: Canaries, MetricTemplates, and AlertProviders.

Reads are bounded and provider-specific. Missing CRDs are treated as an uninstalled provider, while permission failures are reported as partial coverage.

Repository URLs are sanitized before they leave the agent. Helm value-file names and parameter names may be shown, but parameter values are never retained. The Kubernetes Application condition exposes an orphaned-resource count, not the exact Resource Tree. KUBI therefore reports that count honestly; exact orphan object names require a future opt-in Argo CD Resource Tree API integration.

## Detection-only providers

Jenkins, GitLab Runner, Drone, Forgejo Actions, and GitHub Actions Runner installations can be detected from workloads. Their pipeline histories live outside Kubernetes, so KUBI does not claim full coverage and does not request API tokens in this release.

Future external API integrations will keep credentials in the local agent configuration and expose only normalized read-only results through the relay.
