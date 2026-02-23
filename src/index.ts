import { k8sBatchApi, k8sCoreApi, k8sAppsApi } from './k8s.js'
import { getAnnotation } from './utils.js'
import { V1CronJob } from '@kubernetes/client-node'
import qs from 'qs'

const LOOP_INTERVAL_MS: number = 60_000

const defaultMysqlVersion: string = '8'
const defaultPostgresqlVersion: string = '16'

const ksnapshotNamespace: string = 'ksnapshot'

const labelFilters = { 'app.kubernetes.io/managed-by': 'ksnapshot' }
const labelSelector = qs.stringify(labelFilters, { encodeValuesOnly: true })

const looper = async () => {
  const activeCronjobOwners: string[] = []
  const existingCronjobOwners: string[] = []

  const cronjobOwnerAnnotation = getAnnotation('owner')

  const cronjobList = await k8sBatchApi.listCronJobForAllNamespaces({
    labelSelector,
  })

  for (const cronjob of cronjobList.items) {
    const annotations = cronjob.metadata?.annotations
    const owner = annotations?.[cronjobOwnerAnnotation]

    if (owner) {
      existingCronjobOwners.push(owner)
    }
  }

  const podList = await k8sCoreApi.listPodForAllNamespaces()

  for (const pod of podList.items) {
    if (pod.status?.phase !== 'Running') {
      continue
    }

    const namespace = pod.metadata?.namespace as string

    const annotations = pod.metadata?.annotations
    if (!annotations) {
      continue
    }

    const enabledAnnotation = getAnnotation('enabled')

    if (annotations[enabledAnnotation] === 'true') {
      // Parent resource
      let cronjobOwner = ''
      const ownerReferences = pod.metadata?.ownerReferences
      if (ownerReferences) {
        const owner = ownerReferences[0]
        const ownerKind = owner.kind
        const ownerName = owner.name

        cronjobOwner = `${namespace}/${ownerName}`

        if (ownerKind === 'ReplicaSet') {
          // Get Replicaset
          const rs = await k8sAppsApi.readNamespacedReplicaSet({ name: ownerName, namespace })
          const rsOwnerReferences = rs.metadata?.ownerReferences
          if (rsOwnerReferences) {
            const rsOwner = rsOwnerReferences[0]
            const rsOwnerKind = rsOwner.kind
            const rsOwnerName = rsOwner.name

            if (rsOwnerKind === 'Deployment') {
              const deployment = await k8sAppsApi.readNamespacedDeployment({
                name: rsOwnerName,
                namespace,
              })
              cronjobOwner = `${deployment.metadata?.namespace}/${deployment.metadata?.name}`
            }
          }
        }

        activeCronjobOwners.push(cronjobOwner)
      } else {
        console.error(`Pod ${namespace}/${pod.metadata?.name} is orphaned or standalone, skipping`)
        continue
      }

      const type = annotations[getAnnotation('type')]
      let version = annotations[getAnnotation('version')]
      const schedule = annotations[getAnnotation('schedule')]
      const timeZone = annotations[getAnnotation('timezone')] || 'Etc/UTC'

      if (!schedule) {
        console.error(`Schedule not found for Pod ${namespace}/${pod.metadata?.name}, skipping`)
        continue
      }

      // Find service pointing at Pod
      const serviceList = await k8sCoreApi.listNamespacedService({ namespace })
      const service = serviceList.items.find((service) => {
        return Object.entries(service.spec?.selector || {}).every(([key, value]) => {
          return pod.metadata?.labels?.[key] === value
        })
      })

      if (!service) {
        console.error(`Service not found for Pod ${namespace}/${pod.metadata?.name}, skipping`)
        continue
      }

      let cronjobName = ''

      cronjobName = `ksnapshot-${type}-${cronjobOwner.replace('/', '-').substring(0, 20)}`
      const existingCronjob = cronjobList.items.find((cronjob) => {
        return cronjob.metadata?.name === cronjobName
      })

      const podEnv = pod.spec?.containers[0]?.env
      if (!podEnv) {
        console.error(`Pod ${namespace}/${pod.metadata?.name} has no environment variables, skipping`)
        continue
      }

      const snapshotCronjob: V1CronJob = {
        kind: 'CronJob',
        metadata: {
          name: cronjobName,
          namespace: ksnapshotNamespace,
          annotations: {
            [cronjobOwnerAnnotation]: cronjobOwner,
          },
          labels: labelFilters,
        },
        spec: {
          schedule,
          timeZone,
          concurrencyPolicy: 'Forbid',
          successfulJobsHistoryLimit: 1,
          failedJobsHistoryLimit: 1,
          jobTemplate: {
            spec: {
              backoffLimit: 0,
              activeDeadlineSeconds: 14400, // 4 hours
              template: {
                spec: {
                  restartPolicy: 'Never',
                  containers: [
                    {
                      name: 'job',
                      imagePullPolicy: 'Always',
                      image: `ghcr.io/clickandmortar/ksnapshot-dumper-mysql-${version}:latest`,
                      env: [
                        {
                          name: 'BACKEND_TYPE',
                          value: 's3',
                        },
                        {
                          name: 'BACKEND_S3_REGION',
                          value: 'eu-west-1',
                        },
                        {
                          name: 'BACKEND_S3_ACCESS_KEY',
                          valueFrom: {
                            secretKeyRef: {
                              name: 'ksnapshot-secret',
                              key: 'AWS_ACCESS_KEY_ID',
                            },
                          },
                        },
                        {
                          name: 'BACKEND_S3_SECRET_KEY',
                          valueFrom: {
                            secretKeyRef: {
                              name: 'ksnapshot-secret',
                              key: 'AWS_SECRET_ACCESS_KEY',
                            },
                          },
                        },
                        {
                          name: 'BACKEND_BUCKET',
                          valueFrom: {
                            configMapKeyRef: {
                              name: 'ksnapshot-cm',
                              key: 'S3_BUCKET',
                            },
                          },
                        },
                        {
                          name: 'BACKEND_PATH',
                          value: 'ksnapshot',
                        },
                      ],
                      resources: {}, // TODO
                    },
                  ],
                },
              },
            },
          },
        },
      }

      const container = snapshotCronjob.spec!.jobTemplate.spec!.template.spec!.containers[0]

      if (type === 'mysql') {
        version = version || defaultMysqlVersion
        container.image = `ghcr.io/clickandmortar/ksnapshot-dumper-mysql-${version}:latest`
        container.env!.push(
          {
            name: 'MYSQL_HOST',
            value: `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`,
          },
          {
            name: 'MYSQL_PORT',
            value: '3306', // TODO: make dynamic
          },
          {
            name: 'MYSQL_USERNAME',
            value: podEnv.find((env) => env.name === 'MYSQL_USER')?.value || '',
          },
          {
            name: 'MYSQL_PASSWORD',
            value: podEnv.find((env) => env.name === 'MYSQL_PASSWORD')?.value || '',
          },
          {
            name: 'MYSQL_DATABASE',
            value: podEnv.find((env) => env.name === 'MYSQL_DATABASE')?.value || '',
          }
        )
      }

      if (type === 'elasticsearch') {
        const esLimit = annotations[getAnnotation('elasticsearch-limit')]

        container.image = `ghcr.io/clickandmortar/ksnapshot-dumper-elasticsearch:latest`
        container.env!.push(
          {
            name: 'ELASTICSEARCH_HOST',
            value: `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`,
          },
          {
            name: 'ELASTICSEARCH_PORT',
            value: '9200', // TODO: make dynamic
          }
        )

        if (esLimit) {
          container.env!.push({
            name: 'ELASTICDUMP_LIMIT',
            value: String(esLimit),
          })
        }
      }

      if (type === 'postgresql') {
        version = version || defaultPostgresqlVersion
        container.image = `ghcr.io/clickandmortar/ksnapshot-dumper-postgresql-${version}:latest`
        container.env!.push(
          {
            name: 'POSTGRESQL_HOST',
            value: `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`,
          },
          {
            name: 'POSTGRESQL_PORT',
            value: '5432', // TODO: make dynamic
          },
          {
            name: 'POSTGRESQL_USERNAME',
            value: podEnv.find((env) => env.name === 'POSTGRES_USER')?.value || '',
          },
          {
            name: 'POSTGRESQL_PASSWORD',
            value: podEnv.find((env) => env.name === 'POSTGRES_PASSWORD')?.value || '',
          },
          {
            name: 'POSTGRESQL_DATABASE',
            value: podEnv.find((env) => env.name === 'POSTGRES_DB')?.value || '',
          }
        )
      }

      if (!existingCronjob) {
        console.log(`Creating CronJob ${cronjobName}`)
        await k8sBatchApi.createNamespacedCronJob({
          namespace: ksnapshotNamespace,
          body: snapshotCronjob,
        })
      } else {
        console.log(`Updating CronJob ${cronjobName}`)
        await k8sBatchApi.replaceNamespacedCronJob({
          name: cronjobName,
          namespace: ksnapshotNamespace,
          body: snapshotCronjob,
        })
      }
    }
  }

  // Remove cronjobs that are not active anymore
  const cronjobOwnersToRemove = existingCronjobOwners.filter((owner) => !activeCronjobOwners.includes(owner))
  for (const ownerToRemove of cronjobOwnersToRemove) {
    // Remove cronjobs with annotation owner
    const cronjobList = await k8sBatchApi.listCronJobForAllNamespaces({
      labelSelector,
    })

    for (const item of cronjobList.items) {
      const annotations = item.metadata?.annotations
      const owner = annotations?.[cronjobOwnerAnnotation]

      if (owner === ownerToRemove) {
        console.log(`Deleting orphan CronJob ${item.metadata?.namespace}/${item.metadata?.name}`)
        await k8sBatchApi.deleteNamespacedCronJob({
          name: item.metadata?.name as string,
          namespace: item.metadata?.namespace as string,
        })
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const jobLabelFilters = { 'app.kubernetes.io/managed-by': 'ksnapshot' }

  // TODO: delete terminated jobs

  setTimeout(async () => {
    await looper()
  }, LOOP_INTERVAL_MS)
}

process.on('SIGINT', () => {
  console.log('SIGINT, terminating')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('SIGTERM, terminating')
  process.exit(0)
})

await looper()
