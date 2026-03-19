# ksnapshot Helm Chart

A Helm chart for deploying the ksnapshot Kubernetes operator, which watches for annotated pods and creates CronJobs to perform database snapshots (MySQL, Elasticsearch, PostgreSQL) uploaded to S3.

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

## Uninstallation

```bash
helm uninstall ksnapshot -n ksnapshot
```

## Configuration

### Credentials / Secret Management

The operator needs AWS (or S3-compatible) credentials to upload snapshots. Three options are supported:

#### Option A: Let Helm create the secret

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot --create-namespace \
  --set s3.bucket=my-bucket \
  --set secret.create=true \
  --set secret.awsAccessKeyId=AKIAXXXXXXXX \
  --set secret.awsSecretAccessKey=XXXXXXXX
```

#### Option B: Use a pre-existing secret (default)

Create the secret yourself, then reference it:

```bash
kubectl create secret generic ksnapshot-secret -n ksnapshot \
  --from-literal=AWS_ACCESS_KEY_ID=AKIAXXXXXXXX \
  --from-literal=AWS_SECRET_ACCESS_KEY=XXXXXXXX

helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set s3.bucket=my-bucket \
  --set existingSecret=ksnapshot-secret
```

#### Option C: IRSA / Workload Identity (no secret needed)

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot --create-namespace \
  --set s3.bucket=my-bucket \
  --set existingSecret="" \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789:role/ksnapshot
```

### S3 / ConfigMap

By default the chart creates a ConfigMap named `ksnapshot-cm` from the `s3.*` values. To use a pre-existing ConfigMap instead:

```bash
helm install ksnapshot clickandmortar/ksnapshot -n ksnapshot \
  --set existingConfigMap=my-configmap
```

### Annotating Pods

Once the operator is running, annotate pods to enable snapshots:

```bash
kubectl annotate pod <pod-name> \
  ksnapshot.clickandmortar.fr/enabled="true" \
  ksnapshot.clickandmortar.fr/schedule="0 2 * * *" \
  ksnapshot.clickandmortar.fr/type="mysql"
```

See the [project README](../../README.md) for all supported annotations.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `replicaCount` | int | `1` | Number of operator replicas |
| `image.repository` | string | `ghcr.io/clickandmortar/ksnapshot` | Operator image repository |
| `image.tag` | string | `latest` | Operator image tag |
| `image.pullPolicy` | string | `Always` | Image pull policy |
| `imagePullSecrets` | list | `[]` | Image pull secrets |
| `nameOverride` | string | `""` | Override the chart name |
| `fullnameOverride` | string | `""` | Override the full release name |
| `serviceAccount.create` | bool | `true` | Create a ServiceAccount |
| `serviceAccount.annotations` | object | `{}` | ServiceAccount annotations (e.g. for IRSA) |
| `rbac.create` | bool | `true` | Create ClusterRole and ClusterRoleBinding |
| `s3.bucket` | string | `""` | S3 bucket name for snapshots |
| `s3.region` | string | `""` | S3 region (optional) |
| `s3.endpoint` | string | `""` | S3 endpoint for non-AWS providers (optional) |
| `secret.create` | bool | `false` | Create a Secret with AWS credentials |
| `secret.awsAccessKeyId` | string | `""` | AWS access key ID (when `secret.create=true`) |
| `secret.awsSecretAccessKey` | string | `""` | AWS secret access key (when `secret.create=true`) |
| `existingSecret` | string | `"ksnapshot-secret"` | Name of an existing Secret to use |
| `existingConfigMap` | string | `""` | Name of an existing ConfigMap to use instead of creating one |
| `resources` | object | `{}` | CPU/memory resource requests and limits |
| `nodeSelector` | object | `{}` | Node selector constraints |
| `tolerations` | list | `[]` | Pod tolerations |
| `affinity` | object | `{}` | Pod affinity rules |
| `podAnnotations` | object | `{}` | Additional pod annotations |
| `podLabels` | object | `{}` | Additional pod labels |
