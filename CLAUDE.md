# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ksnapshot is a Kubernetes operator that watches for pods with specific annotations and automatically creates/manages CronJobs to perform database snapshots (MySQL and Elasticsearch). Dumps are compressed and uploaded to S3.

## Development Commands

```bash
npm run dev      # Watch mode with tsx (runs tsx watch index.mts)
npm run lint     # Run ESLint
npm install      # Install dependencies
```

**Build & push Docker images:**
```bash
make build       # builds ghcr.io/clickandmortar/* images tagged with VERSION (default: dev)
make push        # pushes ghcr.io/clickandmortar/* images tagged with VERSION
```

Node version: v22 (see `.nvmrc`).

## Architecture

### Operator Loop (`src/index.ts`)
The operator runs an infinite polling loop (60s interval) that:
1. Lists running pods in the configured watched namespaces and checks for `ksnapshot.clickandmortar.fr/*` annotations
2. Resolves pod ownership chain: Pod → ReplicaSet → Deployment
3. Finds the Kubernetes Service matching pod selectors
4. Resolves supported DB credential sources into an operator-managed Secret in the control namespace
5. Creates/updates CronJobs in the control namespace with the appropriate dumper image
6. Cleans up orphaned CronJobs and generated credential Secrets

### Kubernetes API (`src/k8s.ts`)
Initializes KubeConfig with mode detection — `loadFromDefault()` for local dev, `loadFromCluster()` when `MODE=cluster`. Exports three API clients: `k8sCoreApi`, `k8sBatchApi`, `k8sAppsApi`.

### Dumpers (`dumpers/`)
Separate Docker images with shell scripts that perform the actual database dumps:
- **MySQL** (`dumpers/mysql/`): Uses `mysqldump --single-transaction`, gzip, optional age encryption, uploads via osm to S3. Separate Dockerfiles for MySQL 5.7 and 8.
- **Elasticsearch** (`dumpers/elasticsearch/`): Uses `elasticdump`, auto-detects ES version to determine supported dump types, outputs compressed JSONL to S3.
- **PostgreSQL** (`dumpers/postgresql/`): Uses `pg_dump` piped to gzip, optional age encryption, uploads via osm to S3. Dockerfile for PostgreSQL 16.

S3 uploads use dated subdirectories: `/YYYY/MM/DD/{mysql|elasticsearch}/`.

### Configuration via Pod Annotations
Annotation prefix: `ksnapshot.clickandmortar.fr/`

| Annotation | Required | Description |
|-----------|----------|-------------|
| `enabled` | Yes | Enable snapshots for this pod |
| `schedule` | Yes | Cron schedule expression |
| `type` | Yes | `mysql`, `elasticsearch`, or `postgresql` |
| `timezone` | No | Default: `Etc/UTC` |
| `version` | No | Database version (mysql default: `8`, postgresql default: `16`) |
| `elasticsearch-limit` | No | Elasticdump page size (default: `1000`) |
| `encryption-enabled` | No | Enable age encryption before upload (default: `false`) |
| `encryption-recipient` | No | age recipient public key (required when encryption is enabled) |

### Helm Deployment
- Helm is the supported installation path
- The operator runs in its own namespace with namespace-scoped Roles/RoleBindings for each watched namespace
- Expects a Secret `ksnapshot-secret` (AWS credentials) and ConfigMap `ksnapshot-cm` (S3 bucket) in the control namespace

## CI / CD

Three GitHub Actions workflows in `.github/workflows/`:

- **`ci.yaml`** — Runs `npm run lint` and `npm test` on every push to `main` and on PRs.
- **`bump-version.yaml`** — Manual dispatch (`workflow_dispatch`). Accepts a bump type (`patch`, `minor`, `major`). Bumps the version in `package.json` and `chart/ksnapshot/Chart.yaml`, commits as `release: vX.Y.Z`, tags, pushes, and triggers the release workflow. **Never bump versions manually — always use this workflow.**
- **`release.yaml`** — Manual dispatch triggered by bump-version (or manually with a tag). Builds and pushes all Docker images (operator + dumpers) to `ghcr.io/clickandmortar/ksnapshot*`, creates a GitHub Release with the Helm chart `.tgz`, and updates the `gh-pages` Helm repo index.

### Releasing a new version

Trigger the **Bump Version** workflow from the GitHub Actions UI (or via `gh workflow run bump-version.yaml --field bump=minor`). This handles everything: version bump, commit, tag, image builds, Helm chart packaging, and GitHub Release.

## Code Style

- TypeScript with strict mode, ESNext target and module system
- Prettier: single quotes, no semicolons, trailing commas (ES5), 120 char line width
- CI builds push to `ghcr.io/clickandmortar/ksnapshot*`
