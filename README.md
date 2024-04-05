# ksnapshot - Kubernetes snapshotting made easy

Ksnapshot is a Kubernetes operator that allows you to schedule snapshots of your databases.

## Install

```shell script
# Apply manifests
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-sa.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-cr.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-crb.yaml
kubectl apply -f https://raw.githubusercontent.com/ClickAndMortar/ksnapshot/master/manifests/deployment/ksnapshot-deployment.yaml
```

## Usage

To schedule a snapshot, you may use the following annotations on a `Pod`: 

| Annotation                             | Description                                     | Required | Default         |
|----------------------------------------|-------------------------------------------------|----------|-----------------|
| `ksnapshot.clickandmortar.fr/enabled`  | Enable snapshotting                             | Yes      | `false`         |
| `ksnapshot.clickandmortar.fr/schedule` | Snapshot schedule                               | Yes      |                 |
| `ksnapshot.clickandmortar.fr/timezone` | Snapshot schedule timezone                      | No       | `Etc/UTC`       |
| `ksnapshot.clickandmortar.fr/type`     | Snapshot type (`mysql` or `elasticsearch`)      | Yes      |                 |
| `ksnapshot.clickandmortar.fr/version`  | Data source main version (`mysql`: `5.7` or `8` | No       | `8` for `mysql` |


## Enhancements

* [ ] Encrypt files before uploading to object storage using AWS KMS
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
