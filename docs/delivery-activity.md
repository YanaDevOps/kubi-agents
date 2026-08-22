# Delivery Activity

KUBI Agent reads delivery state from Kubernetes APIs through the selected kubeconfig. The hosted service receives normalized status and metadata, not repository credentials, Kubernetes Secret values, or raw kubeconfigs.

## Native coverage

- Argo CD: Applications, ApplicationSets, AppProjects, source revisions, health, sync policy, and sync windows.
- Flux: Kustomizations, HelmReleases, source objects, and ImageUpdateAutomations.
- Tekton: Pipelines, Tasks, PipelineRuns, and TaskRuns.
- Argo Workflows: Workflows, CronWorkflows, WorkflowTemplates, and ClusterWorkflowTemplates.
- Argo Rollouts: Rollouts, AnalysisRuns, AnalysisTemplates, and ClusterAnalysisTemplates.
- Flagger: Canaries, MetricTemplates, and AlertProviders.

Reads are bounded and provider-specific. Missing CRDs are treated as an uninstalled provider, while permission failures are reported as partial coverage.

## Detection-only providers

Jenkins, GitLab Runner, Drone, Forgejo Actions, and GitHub Actions Runner installations can be detected from workloads. Their pipeline histories live outside Kubernetes, so KUBI does not claim full coverage and does not request API tokens in this release.

Future external API integrations will keep credentials in the local agent configuration and expose only normalized read-only results through the relay.
