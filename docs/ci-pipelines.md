# External CI Pipelines

Agent `v0.1.34+` exposes read-only run metadata for GitHub Actions, GitLab CI, and Jenkins in **Platform -> CD & Pipelines -> CI Pipelines**.

Provider credentials stay in protected files on the agent host. The hosted KUBI control plane receives normalized provider, project, pipeline, run status, timing, branch, commit, actor, and web-link metadata. It does not request or expose logs, artifacts, variables, workspaces, credentials, or mutation endpoints.

## Configuration

```yaml
ci:
  enabled: true
  github_actions:
    enabled: true
    instances:
      - id: github-production
        display_name: GitHub production
        base_url: https://api.github.com
        repositories:
          - owner: yana-devops
            name: kubi
        max_runs: 100
        auth:
          token_file: /etc/kubi-agent/credentials/github.token

  gitlab_ci:
    enabled: true
    instances:
      - id: gitlab-production
        display_name: GitLab production
        base_url: https://gitlab.example.com
        projects:
          - platform/api
        max_runs: 100
        auth:
          token_file: /etc/kubi-agent/credentials/gitlab.token

  jenkins:
    enabled: true
    instances:
      - id: jenkins-production
        display_name: Jenkins production
        base_url: https://jenkins.example.com
        allowed_job_roots:
          - platform
        max_jobs: 100
        max_runs: 100
        auth:
          username_file: /etc/kubi-agent/credentials/jenkins.username
          api_token_file: /etc/kubi-agent/credentials/jenkins.token
```

Restart the agent after editing the file:

```sh
sudo kubi-agent config validate
sudo systemctl restart kubi-agent
journalctl -u kubi-agent -n 100 --no-pager
```

## Credential Files

Create a dedicated directory and restrict every credential file to the service account:

```sh
sudo install -d -m 0700 /etc/kubi-agent/credentials
sudo install -m 0600 /dev/null /etc/kubi-agent/credentials/github.token
sudo install -m 0600 /dev/null /etc/kubi-agent/credentials/gitlab.token
sudo install -m 0600 /dev/null /etc/kubi-agent/credentials/jenkins.username
sudo install -m 0600 /dev/null /etc/kubi-agent/credentials/jenkins.token
```

The agent rejects non-regular files and POSIX files readable by group or other users. It never prints credential contents through logs or `config show --effective`.

## Least Privilege

- GitHub Actions: use a fine-grained token limited to the configured repositories with read-only Actions and repository metadata access.
- GitLab CI: use a project or group access token with `read_api` only for the configured projects.
- Jenkins: use a dedicated service user with `Overall/Read` and `Job/Read` only on the configured folders or jobs. Do not grant Build, Configure, Workspace, Credentials, or Administer.

Use a custom CA file for internal HTTPS endpoints. Client certificate and key files may be configured together for mTLS. Do not disable TLS verification.

## Runtime Limits

Provider requests use GET only. Redirects are accepted only within the original origin and are limited to one hop. Request duration, response size, concurrency, repository/project/job scope, and returned history are bounded. A short cache reduces repeated provider traffic; a bounded stale response may be returned during a temporary provider outage and is labeled accordingly.

Basic workspaces can expose one configured provider instance and up to 20 recent matching runs. Premium workspaces have no KUBI product limit, while the customer-defined agent bounds still apply.

## Troubleshooting

If a provider does not appear:

1. Run `kubi-agent config validate`.
2. Confirm `ci.enabled: true` and that the instance has a stable `id`.
3. Confirm the credential file owner and mode.
4. Verify the agent host can reach the provider HTTPS endpoint.
5. Review `journalctl -u kubi-agent` for the sanitized provider error.

Changing CI configuration does not require re-pairing. Restart the existing agent and refresh **CD & Pipelines**.
