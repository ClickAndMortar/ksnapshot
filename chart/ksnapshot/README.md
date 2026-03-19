# ksnapshot Helm Chart

A Helm chart for deploying the ksnapshot Kubernetes operator, which watches for annotated pods and creates CronJobs to perform database snapshots uploaded to S3-compatible storage.

## Prerequisites

- Kubernetes 1.21+
- Helm 3+

## Installation

```bash
helm repo add clickandmortar https://clickandmortar.github.io/ksnapshot
helm repo update
helm install ksnapshot clickandmortar/ksnapshot \
  -n ksnapshot --create-namespace \
  --set s3.bucket=my-backup-bucket
```

### From source

```bash
helm install ksnapshot chart/ksnapshot \
  -n ksnapshot --create-namespace \
  --set s3.bucket=my-backup-bucket
```

The release namespace becomes the control namespace for generated CronJobs, Jobs, ConfigMap / Secret references, and the dedicated backup-job ServiceAccount.

## Uninstallation

```bash
helm uninstall ksnapshot -n ksnapshot
```

## Configuration

### Credentials / Secret Management

Backup jobs can authenticate to S3 in three ways:

#### Option A: Let Helm create the Secret

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot --create-namespace \
  --set s3.bucket=my-bucket \
  --set secret.create=true \
  --set secret.awsAccessKeyId=AKIAXXXXXXXX \
  --set secret.awsSecretAccessKey=XXXXXXXX
```

#### Option B: Use a pre-existing Secret

```bash
kubectl create secret generic ksnapshot-secret -n ksnapshot \
  --from-literal=AWS_ACCESS_KEY_ID=AKIAXXXXXXXX \
  --from-literal=AWS_SECRET_ACCESS_KEY=XXXXXXXX

helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set s3.bucket=my-bucket \
  --set existingSecret=ksnapshot-secret
```

#### Option C: IRSA / Workload Identity on the backup-job ServiceAccount

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot --create-namespace \
  --set s3.bucket=my-bucket \
  --set existingSecret="" \
  --set backupJob.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789:role/ksnapshot
```

The operator ServiceAccount keeps Kubernetes RBAC. The backup-job ServiceAccount is separate and is the place to attach cloud identity annotations.

### ConfigMap / Secret references

By default the chart creates `ksnapshot-cm` from `s3.*` values and expects `ksnapshot-secret` unless `secret.create=true` or `existingSecret=""`.

Use a pre-existing ConfigMap:

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set existingConfigMap=my-configmap
```

Use an existing backup-job ServiceAccount instead of creating one:

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set backupJob.serviceAccount.create=false \
  --set backupJob.serviceAccount.name=my-existing-backup-sa
```

### Dumper images

Each dumper image can be pinned independently. When left empty, the chart derives the dumper image tag from `image.tag`.

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set dumperImages.mysql.v8=ghcr.io/clickandmortar/ksnapshot-dumper-mysql-8:v1.2.3 \
  --set dumperImages.postgresql.v16=ghcr.io/clickandmortar/ksnapshot-dumper-postgresql-16:v1.2.3 \
  --set dumperImages.elasticsearch=ghcr.io/clickandmortar/ksnapshot-dumper-elasticsearch:v1.2.3
```

### Workload requirements

- The annotated workload must be matched by exactly one selector-based Service.
- MySQL and PostgreSQL credentials can come from literal `env`, `env.valueFrom`, or `envFrom` on the source container.
- Generated backup CronJobs run as the dedicated backup-job ServiceAccount, not the namespace default ServiceAccount.

### Encryption

All dumpers support optional [age](https://github.com/FiloSottile/age) encryption.

```bash
kubectl annotate pod <pod-name> \
  ksnapshot.clickandmortar.fr/encryption-enabled="true" \
  ksnapshot.clickandmortar.fr/encryption-recipient="age1..."
```

### Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `replicaCount` | int | `1` | Number of operator replicas |
| `image.repository` | string | `ghcr.io/clickandmortar/ksnapshot` | Operator image repository |
| `image.tag` | string | `latest` | Operator image tag |
| `image.pullPolicy` | string | `IfNotPresent` | Operator image pull policy |
| `imagePullSecrets` | list | `[]` | Image pull secrets |
| `serviceAccount.create` | bool | `true` | Create the operator ServiceAccount |
| `serviceAccount.name` | string | `""` | Override the operator ServiceAccount name |
| `serviceAccount.annotations` | object | `{}` | Operator ServiceAccount annotations |
| `backupJob.imagePullPolicy` | string | `IfNotPresent` | Pull policy for generated backup jobs |
| `backupJob.serviceAccount.create` | bool | `true` | Create the backup-job ServiceAccount |
| `backupJob.serviceAccount.name` | string | `""` | Override the backup-job ServiceAccount name |
| `backupJob.serviceAccount.annotations` | object | `{}` | Backup-job ServiceAccount annotations (for IRSA / Workload Identity) |
| `rbac.create` | bool | `true` | Create ClusterRole, ClusterRoleBinding, Role, and RoleBinding |
| `dumperImages.mysql.v5_7` | string | `""` | Full image ref for the MySQL 5.7 dumper |
| `dumperImages.mysql.v8` | string | `""` | Full image ref for the MySQL 8 dumper |
| `dumperImages.postgresql.v16` | string | `""` | Full image ref for the PostgreSQL 16 dumper |
| `dumperImages.elasticsearch` | string | `""` | Full image ref for the Elasticsearch dumper |
| `s3.bucket` | string | `""` | S3 bucket name for snapshots |
| `s3.region` | string | `""` | S3 region |
| `s3.endpoint` | string | `""` | S3 endpoint for non-AWS providers |
| `secret.create` | bool | `false` | Create a Secret with AWS credentials |
| `secret.awsAccessKeyId` | string | `""` | AWS access key ID when `secret.create=true` |
| `secret.awsSecretAccessKey` | string | `""` | AWS secret access key when `secret.create=true` |
| `existingSecret` | string | `"ksnapshot-secret"` | Existing Secret name, or `""` for identity-only auth |
| `existingConfigMap` | string | `""` | Existing ConfigMap name |
| `resources` | object | `{}` | Operator CPU/memory resource requests and limits |
| `nodeSelector` | object | `{}` | Node selector constraints |
| `tolerations` | list | `[]` | Pod tolerations |
| `affinity` | object | `{}` | Pod affinity rules |
| `podAnnotations` | object | `{}` | Additional operator pod annotations |
| `podLabels` | object | `{}` | Additional operator pod labels |

See the [project README](../../README.md) for annotations and kubectl installation.
