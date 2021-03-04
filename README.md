# ksnapshot - Kubernetes snapshotting made easy

## Usage

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
