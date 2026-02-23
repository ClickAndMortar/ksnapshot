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
make build       # docker build -t clickandmortar/ksnapshot:latest .
make push        # docker push clickandmortar/ksnapshot:latest
```

Node version: v22 (see `.nvmrc`).

## Architecture

### Operator Loop (`src/index.ts`)
The operator runs an infinite polling loop (60s interval) that:
1. Lists all running pods and checks for `ksnapshot.clickandmortar.fr/*` annotations
2. Resolves pod ownership chain: Pod → ReplicaSet → Deployment
3. Finds the Kubernetes Service matching pod selectors
4. Creates/updates CronJobs in the `ksnapshot` namespace with the appropriate dumper image
5. Cleans up orphaned CronJobs for pods that no longer exist or are disabled

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

### Kubernetes Resources (`manifests/`)
- Operator runs in `ksnapshot` namespace with a dedicated ServiceAccount, ClusterRole, and ClusterRoleBinding
- Expects a Secret `ksnapshot-secret` (AWS credentials) and ConfigMap `ksnapshot-cm` (S3 bucket) in the `ksnapshot` namespace

## Code Style

- TypeScript with strict mode, ESNext target and module system
- Prettier: single quotes, no semicolons, trailing commas (ES5), 120 char line width
- CI builds push to `ghcr.io/clickandmortar/ksnapshot*`
