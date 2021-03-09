# ksnapshot - Kubernetes snapshotting made easy

## Install

```shell script
# Create CRD in your cluster
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/crd/ksnapshotschedule-crd.yaml

# Apply manifests
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-sa.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-cr.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-crb.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-deployment.yaml
```

## Usage

### Create a snapshot schedule

Here is a sample of a MySQL database snapshot schedule:

```yaml
apiVersion: ksnapshot.clickandmortar.io/v1alpha1
kind: KSnapshotSchedule
metadata:
  name: my-snapshot-schedule
spec:
  cronSpec: "42 0 * * *" # UTC
  type: mysql
  config:
    mysql:
      version: "8"
      host: mysql-service.namespace.svc.cluster.local
      username: my-username
      passwordSecretKeyRef:
        name: mysql-secret
        key: password
      database: my-database
  encryption:
    enabled: true
    recipient: <age-public-key|ssh public key>
  backend:
    type: s3
    config:
      path: /my/path/
      bucket: my-bucket
      s3Endpoint: https://s3-endpoint.com
      s3AccessKey: XXXXXXXXXXXXXXXXXXXX
      s3SecretKeyRef:
        name: s3-credentials-secret
        key: secretKey
```

### Encryption

Encryption of files is done by [age](https://github.com/FiloSottile/age) utility using given recipients, which can be an age or SSH public key.

To generate an age public/private key pair:

```shell script
age-keygen -o age-keypair.txt
```

To decrypt those:

```shell script
age --decrypt -i age-keypair.txt -o dump.gz dump.gz.age
```

## Enhancements

* [x] Encrypt files before uploading to object storage
* [ ] Allow using a PVC or claiming a PV for large dumps
* [ ] Allow defining resources requests/limits on dumpers
* MySQL
  * [x] Include/exclude tables
  * [ ] One dump per table
* Elasticsearch
  * [ ] Create dumper image
  * [ ] Add support
* Persistent Volumes backuping
  * [ ] Add support
  * [ ] Handle conditions (ie. files modified since)
