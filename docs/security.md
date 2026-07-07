# Security Model

KUBI Agent is designed so Kubernetes access stays customer-side.

## What Stays Local

- Raw kubeconfig files
- Client certificates and keys
- Exec auth dependencies such as AWS CLI, `gcloud`, Azure CLI, or `kubelogin`
- Kubernetes API credentials
- Local alerting config and delivery history

## What Is Sent To KUBI SaaS

- Agent registration metadata
- Heartbeats and version/capability metadata
- Sanitized kubeconfig discovery metadata
- Read-only runtime responses requested by the browser through the local loopback agent

## Pairing Token

The pairing token is one-time and short-lived. It is used only to register the agent. After pairing, the agent receives its own credential and stores it in the local config file.

## Loopback Runtime

The agent listens on `127.0.0.1:47641`. It validates browser-origin access and uses short-lived access tokens issued by the SaaS control plane.

Do not expose the loopback runtime to the public internet.

## Artifact Verification

Installers download the binary and `.sha256` file, verify checksum before pairing, then install the service. Release assets also include cosign signatures and certificates.
