import { createHash } from 'node:crypto'
import type {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  V1Container,
  V1CronJob,
  V1EnvFromSource,
  V1EnvVar,
  V1Job,
  V1Pod,
  V1SecurityContext,
  V1Service,
} from '@kubernetes/client-node'
import qs from 'qs'
import { getAnnotation } from './utils.js'

export const LOOP_INTERVAL_MS = 60_000

const BACKUP_PATH = 'ksnapshot'
const COMPLETED_JOB_RETENTION_SECONDS = 86_400
const DEFAULT_ELASTICSEARCH_LIMIT = '1000'
const DEFAULT_MYSQL_VERSION = '8'
const DEFAULT_POSTGRESQL_VERSION = '16'
const RUN_AS_UID = 65532
const TMP_VOLUME_NAME = 'tmp'

type SnapshotType = 'mysql' | 'postgresql' | 'elasticsearch'

export const labelFilters = { 'app.kubernetes.io/managed-by': 'ksnapshot' }
export const labelSelector = qs.stringify(labelFilters, { encodeValuesOnly: true })

export interface ControllerConfig {
  controlNamespace: string
  backupConfigMapName: string
  backupSecretName: string
  backupJobServiceAccountName: string
  backupImagePullPolicy: string
  images: {
    mysql57: string
    mysql8: string
    postgresql16: string
    elasticsearch: string
  }
}

export interface ControllerApis {
  appsApi: AppsV1Api
  batchApi: BatchV1Api
  coreApi: CoreV1Api
}

interface WorkloadSettings {
  owner: string
  namespace: string
  type: SnapshotType
  schedule: string
  timeZone: string
  version?: string
  elasticsearchLimit?: string
  encryptionEnabled: boolean
  encryptionRecipient?: string
}

interface WorkloadGroup extends WorkloadSettings {
  pods: V1Pod[]
  sourceContainer: V1Container
}

interface DatabaseEnvProjection {
  env: V1EnvVar[]
  envFrom: V1EnvFromSource[]
}

interface ServiceMatchResult {
  service?: V1Service
  error?: string
}

const containerSecurityContext: V1SecurityContext = {
  allowPrivilegeEscalation: false,
  capabilities: {
    drop: ['ALL'],
  },
  readOnlyRootFilesystem: true,
}

const mysqlEnvMappings: ReadonlyArray<[string, string]> = [
  ['MYSQL_USER', 'MYSQL_USERNAME'],
  ['MYSQL_PASSWORD', 'MYSQL_PASSWORD'],
  ['MYSQL_DATABASE', 'MYSQL_DATABASE'],
]

const postgresqlEnvMappings: ReadonlyArray<[string, string]> = [
  ['POSTGRES_USER', 'POSTGRESQL_USERNAME'],
  ['POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD'],
  ['POSTGRES_DB', 'POSTGRESQL_DATABASE'],
]

export const buildControllerConfig = (env: NodeJS.ProcessEnv = process.env): ControllerConfig => {
  return {
    controlNamespace: env.CONTROL_NAMESPACE || 'ksnapshot',
    backupConfigMapName: env.BACKUP_CONFIGMAP_NAME || 'ksnapshot-cm',
    backupSecretName: env.BACKUP_SECRET_NAME || '',
    backupJobServiceAccountName: env.BACKUP_JOB_SERVICE_ACCOUNT_NAME || 'ksnapshot-backup-sa',
    backupImagePullPolicy: env.BACKUP_IMAGE_PULL_POLICY || 'IfNotPresent',
    images: {
      mysql57: env.MYSQL_DUMPER_IMAGE_5_7 || 'ghcr.io/clickandmortar/ksnapshot-dumper-mysql-5.7:latest',
      mysql8: env.MYSQL_DUMPER_IMAGE_8 || 'ghcr.io/clickandmortar/ksnapshot-dumper-mysql-8:latest',
      postgresql16:
        env.POSTGRESQL_DUMPER_IMAGE_16 || 'ghcr.io/clickandmortar/ksnapshot-dumper-postgresql-16:latest',
      elasticsearch:
        env.ELASTICSEARCH_DUMPER_IMAGE || 'ghcr.io/clickandmortar/ksnapshot-dumper-elasticsearch:latest',
    },
  }
}

export const buildCronJobName = (type: SnapshotType, owner: string): string => {
  const hash = createHash('sha256').update(owner).digest('hex').slice(0, 8)
  const base = `ksnapshot-${type}-`
  const suffix = `-${hash}`
  const maxPrefixLength = Math.max(1, 52 - base.length - suffix.length)
  const prefix = normalizeDnsLabel(owner.replace('/', '-')).slice(0, maxPrefixLength).replace(/-+$/g, '')
  return `${base}${prefix || 'owner'}${suffix}`
}

export const findMatchingService = (services: V1Service[], pods: V1Pod[]): ServiceMatchResult => {
  const matches = services.filter((service) => {
    const selectors = Object.entries(service.spec?.selector || {})
    if (selectors.length === 0) {
      return false
    }

    return pods.every((pod) => {
      const labels = pod.metadata?.labels || {}
      return selectors.every(([key, value]) => labels[key] === value)
    })
  })

  if (matches.length === 1) {
    return { service: matches[0] }
  }

  if (matches.length === 0) {
    return { error: 'No selector-based Service matches this workload' }
  }

  return {
    error: `Multiple selector-based Services match this workload: ${matches
      .map((service) => service.metadata?.name)
      .filter(Boolean)
      .join(', ')}`,
  }
}

export const projectDatabaseEnv = (
  container: Pick<V1Container, 'env' | 'envFrom'>,
  mappings: ReadonlyArray<[string, string]>
): DatabaseEnvProjection => {
  const env: V1EnvVar[] = []

  for (const [sourceName, targetName] of mappings) {
    const projected = projectEnvVar(container.env || [], sourceName, targetName)
    if (projected) {
      env.push(projected)
    }
  }

  return {
    env,
    envFrom: (container.envFrom || []).map((envFromSource) => ({ ...envFromSource })),
  }
}

export const selectDumperImage = (
  config: ControllerConfig,
  type: SnapshotType,
  version?: string
): string | null => {
  if (type === 'mysql') {
    if (version === '5.7') {
      return config.images.mysql57
    }

    if (version === '8') {
      return config.images.mysql8
    }

    return null
  }

  if (type === 'postgresql') {
    return version === '16' ? config.images.postgresql16 : null
  }

  return config.images.elasticsearch
}

export const reconcileOnce = async (apis: ControllerApis, config: ControllerConfig): Promise<void> => {
  const existingCronJobs = await apis.batchApi.listNamespacedCronJob({
    namespace: config.controlNamespace,
    labelSelector,
  })
  const existingCronJobsByName = new Map(
    existingCronJobs.items
      .map((cronJob) => [cronJob.metadata?.name, cronJob] as const)
      .filter((entry): entry is [string, V1CronJob] => Boolean(entry[0]))
  )

  const podList = await apis.coreApi.listPodForAllNamespaces()
  const { activeOwners, workloads } = await collectWorkloads(podList.items, apis.appsApi)
  const servicesByNamespace = new Map<string, V1Service[]>()

  for (const workload of workloads) {
    try {
      let services = servicesByNamespace.get(workload.namespace)
      if (!services) {
        const serviceList = await apis.coreApi.listNamespacedService({ namespace: workload.namespace })
        services = serviceList.items
        servicesByNamespace.set(workload.namespace, services)
      }

      const match = findMatchingService(services, workload.pods)
      if (!match.service) {
        console.error(`Skipping ${workload.owner}: ${match.error}`)
        continue
      }

      const cronJobName = buildCronJobName(workload.type, workload.owner)
      const existingCronJob = existingCronJobsByName.get(cronJobName)
      const snapshotCronJob = buildSnapshotCronJob(config, workload, match.service, existingCronJob)

      if (!existingCronJob) {
        console.log(`Creating CronJob ${config.controlNamespace}/${cronJobName}`)
        try {
          await apis.batchApi.createNamespacedCronJob({
            namespace: config.controlNamespace,
            body: snapshotCronJob,
          })
        } catch (error) {
          if (!isRecoverableKubernetesConflict(error)) {
            throw error
          }

          console.warn(`Create conflicted for ${config.controlNamespace}/${cronJobName}, will retry next loop`)
        }

        continue
      }

      console.log(`Updating CronJob ${config.controlNamespace}/${cronJobName}`)
      try {
        await apis.batchApi.replaceNamespacedCronJob({
          name: cronJobName,
          namespace: config.controlNamespace,
          body: snapshotCronJob,
        })
      } catch (error) {
        if (!isRecoverableKubernetesConflict(error)) {
          throw error
        }

        console.warn(`Update conflicted for ${config.controlNamespace}/${cronJobName}, will retry next loop`)
      }
    } catch (error) {
      console.error(`Failed to reconcile ${workload.owner}: ${formatError(error)}`)
    }
  }

  for (const cronJob of existingCronJobs.items) {
    const name = cronJob.metadata?.name
    const owner = cronJob.metadata?.annotations?.[getAnnotation('owner')]
    if (!name || !owner || activeOwners.has(owner)) {
      continue
    }

    try {
      console.log(`Deleting orphan CronJob ${config.controlNamespace}/${name}`)
      await apis.batchApi.deleteNamespacedCronJob({
        name,
        namespace: config.controlNamespace,
      })
    } catch (error) {
      console.error(`Failed to delete orphan CronJob ${config.controlNamespace}/${name}: ${formatError(error)}`)
    }
  }

  await deleteTerminatedJobs(apis.batchApi, config.controlNamespace)
}

export const collectWorkloads = async (
  pods: V1Pod[],
  appsApi: AppsV1Api
): Promise<{ activeOwners: Set<string>; workloads: WorkloadGroup[] }> => {
  const activeOwners = new Set<string>()
  const invalidOwners = new Set<string>()
  const groups = new Map<string, WorkloadGroup>()
  const ownerCache = new Map<string, string>()

  for (const pod of pods) {
    if (pod.status?.phase !== 'Running') {
      continue
    }

    const annotations = pod.metadata?.annotations
    if (!annotations || annotations[getAnnotation('enabled')] !== 'true') {
      continue
    }

    try {
      const settings = normalizeWorkloadSettings(pod)
      if (!settings) {
        continue
      }

      const owner = await resolveOwner(pod, appsApi, ownerCache)
      if (!owner) {
        console.error(`Pod ${formatPodName(pod)} is orphaned or standalone, skipping`)
        continue
      }

      activeOwners.add(owner)

      if (invalidOwners.has(owner)) {
        continue
      }

      const sourceContainer = selectSourceContainer(pod, settings.type)
      if (!sourceContainer) {
        console.error(`Pod ${formatPodName(pod)} has no suitable source container, skipping`)
        continue
      }

      const nextGroup: WorkloadGroup = {
        ...settings,
        owner,
        namespace: pod.metadata?.namespace as string,
        pods: [pod],
        sourceContainer,
      }

      const existingGroup = groups.get(owner)
      if (!existingGroup) {
        groups.set(owner, nextGroup)
        continue
      }

      if (!sameSettings(existingGroup, nextGroup)) {
        invalidOwners.add(owner)
        groups.delete(owner)
        console.error(`Skipping ${owner}: pods in the same workload have conflicting snapshot annotations`)
        continue
      }

      existingGroup.pods.push(pod)
      if (comparePodNames(pod, existingGroup.pods[0]) < 0) {
        existingGroup.sourceContainer = sourceContainer
      }
    } catch (error) {
      console.error(`Failed to inspect ${formatPodName(pod)}: ${formatError(error)}`)
    }
  }

  return {
    activeOwners,
    workloads: Array.from(groups.values()).sort((left, right) => left.owner.localeCompare(right.owner)),
  }
}

const buildSnapshotCronJob = (
  config: ControllerConfig,
  workload: WorkloadGroup,
  service: V1Service,
  existingCronJob?: V1CronJob
): V1CronJob => {
  const env = buildBackendEnv(config)
  let envFrom: V1EnvFromSource[] | undefined
  const serviceHost = `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`

  if (workload.type === 'mysql') {
    const projection = projectDatabaseEnv(workload.sourceContainer, mysqlEnvMappings)
    env.push(
      { name: 'MYSQL_HOST', value: serviceHost },
      { name: 'MYSQL_PORT', value: '3306' },
      ...projection.env
    )
    envFrom = projection.envFrom.length > 0 ? projection.envFrom : undefined
  }

  if (workload.type === 'postgresql') {
    const projection = projectDatabaseEnv(workload.sourceContainer, postgresqlEnvMappings)
    env.push(
      { name: 'POSTGRESQL_HOST', value: serviceHost },
      { name: 'POSTGRESQL_PORT', value: '5432' },
      ...projection.env
    )
    envFrom = projection.envFrom.length > 0 ? projection.envFrom : undefined
  }

  if (workload.type === 'elasticsearch') {
    env.push(
      { name: 'ELASTICSEARCH_HOST', value: serviceHost },
      { name: 'ELASTICSEARCH_PORT', value: '9200' },
      { name: 'ELASTICDUMP_LIMIT', value: workload.elasticsearchLimit || DEFAULT_ELASTICSEARCH_LIMIT }
    )
  }

  if (workload.encryptionEnabled && workload.encryptionRecipient) {
    env.push(
      { name: 'ENCRYPTION_ENABLED', value: 'true' },
      { name: 'ENCRYPTION_RECIPIENT', value: workload.encryptionRecipient }
    )
  }

  const image = selectDumperImage(config, workload.type, workload.version)
  if (!image) {
    throw new Error(`No dumper image configured for ${workload.type} version ${workload.version || '(none)'}`)
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      annotations: {
        [getAnnotation('owner')]: workload.owner,
      },
      labels: labelFilters,
      name: buildCronJobName(workload.type, workload.owner),
      namespace: config.controlNamespace,
      resourceVersion: existingCronJob?.metadata?.resourceVersion,
    },
    spec: {
      concurrencyPolicy: 'Forbid',
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        spec: {
          activeDeadlineSeconds: 14_400,
          backoffLimit: 0,
          template: {
            metadata: {
              labels: labelFilters,
            },
            spec: {
              automountServiceAccountToken: false,
              containers: [
                {
                  env,
                  envFrom,
                  image,
                  imagePullPolicy: config.backupImagePullPolicy,
                  name: 'job',
                  securityContext: { ...containerSecurityContext },
                  volumeMounts: [
                    {
                      mountPath: '/tmp',
                      name: TMP_VOLUME_NAME,
                    },
                  ],
                },
              ],
              restartPolicy: 'Never',
              securityContext: {
                fsGroup: RUN_AS_UID,
                runAsGroup: RUN_AS_UID,
                runAsNonRoot: true,
                runAsUser: RUN_AS_UID,
                seccompProfile: {
                  type: 'RuntimeDefault',
                },
              },
              serviceAccountName: config.backupJobServiceAccountName,
              volumes: [
                {
                  emptyDir: {},
                  name: TMP_VOLUME_NAME,
                },
              ],
            },
          },
        },
      },
      schedule: workload.schedule,
      successfulJobsHistoryLimit: 1,
      timeZone: workload.timeZone,
    },
  }
}

const buildBackendEnv = (config: ControllerConfig): V1EnvVar[] => {
  const env: V1EnvVar[] = [
    {
      name: 'BACKEND_TYPE',
      value: 's3',
    },
    {
      name: 'BACKEND_PATH',
      value: BACKUP_PATH,
    },
  ]

  if (config.backupConfigMapName) {
    env.push(
      {
        name: 'BACKEND_S3_REGION',
        valueFrom: {
          configMapKeyRef: {
            key: 'S3_REGION',
            name: config.backupConfigMapName,
            optional: true,
          },
        },
      },
      {
        name: 'BACKEND_S3_ENDPOINT',
        valueFrom: {
          configMapKeyRef: {
            key: 'S3_ENDPOINT',
            name: config.backupConfigMapName,
            optional: true,
          },
        },
      },
      {
        name: 'BACKEND_BUCKET',
        valueFrom: {
          configMapKeyRef: {
            key: 'S3_BUCKET',
            name: config.backupConfigMapName,
          },
        },
      }
    )
  }

  if (config.backupSecretName) {
    env.push(
      {
        name: 'BACKEND_S3_ACCESS_KEY',
        valueFrom: {
          secretKeyRef: {
            key: 'AWS_ACCESS_KEY_ID',
            name: config.backupSecretName,
          },
        },
      },
      {
        name: 'BACKEND_S3_SECRET_KEY',
        valueFrom: {
          secretKeyRef: {
            key: 'AWS_SECRET_ACCESS_KEY',
            name: config.backupSecretName,
          },
        },
      }
    )
  }

  return env
}

const normalizeWorkloadSettings = (pod: V1Pod): Omit<WorkloadSettings, 'owner' | 'namespace'> | null => {
  const annotations = pod.metadata?.annotations
  if (!annotations) {
    return null
  }

  const type = normalizeSnapshotType(annotations[getAnnotation('type')])
  if (!type) {
    console.error(`Pod ${formatPodName(pod)} has an invalid or unsupported snapshot type, skipping`)
    return null
  }

  const schedule = annotations[getAnnotation('schedule')]
  if (!schedule) {
    console.error(`Pod ${formatPodName(pod)} is missing ${getAnnotation('schedule')}, skipping`)
    return null
  }

  const version = normalizeVersion(type, annotations[getAnnotation('version')])
  if (version instanceof Error) {
    console.error(`Pod ${formatPodName(pod)} ${version.message}, skipping`)
    return null
  }

  const encryptionEnabled = annotations[getAnnotation('encryption-enabled')] === 'true'
  const encryptionRecipient = annotations[getAnnotation('encryption-recipient')] || undefined
  if (encryptionEnabled && !encryptionRecipient) {
    console.error(`Pod ${formatPodName(pod)} enables encryption without a recipient, skipping`)
    return null
  }

  return {
    type,
    schedule,
    timeZone: annotations[getAnnotation('timezone')] || 'Etc/UTC',
    version,
    elasticsearchLimit:
      type === 'elasticsearch'
        ? annotations[getAnnotation('elasticsearch-limit')] || DEFAULT_ELASTICSEARCH_LIMIT
        : undefined,
    encryptionEnabled,
    encryptionRecipient,
  }
}

const normalizeSnapshotType = (value?: string): SnapshotType | null => {
  if (value === 'mysql' || value === 'postgresql' || value === 'elasticsearch') {
    return value
  }

  return null
}

const normalizeVersion = (type: SnapshotType, version?: string): string | undefined | Error => {
  if (type === 'mysql') {
    const effectiveVersion = version || DEFAULT_MYSQL_VERSION
    return effectiveVersion === '5.7' || effectiveVersion === '8'
      ? effectiveVersion
      : new Error(`uses unsupported mysql version ${effectiveVersion}`)
  }

  if (type === 'postgresql') {
    const effectiveVersion = version || DEFAULT_POSTGRESQL_VERSION
    return effectiveVersion === '16'
      ? effectiveVersion
      : new Error(`uses unsupported postgresql version ${effectiveVersion}`)
  }

  return undefined
}

const resolveOwner = async (
  pod: V1Pod,
  appsApi: AppsV1Api,
  cache: Map<string, string>
): Promise<string | null> => {
  const namespace = pod.metadata?.namespace
  const ownerReference = pod.metadata?.ownerReferences?.[0]

  if (!namespace || !ownerReference?.name) {
    return null
  }

  if (ownerReference.kind !== 'ReplicaSet') {
    return `${namespace}/${ownerReference.name}`
  }

  const cacheKey = `${namespace}/${ownerReference.name}`
  const cachedOwner = cache.get(cacheKey)
  if (cachedOwner) {
    return cachedOwner
  }

  const replicaSet = await appsApi.readNamespacedReplicaSet({
    name: ownerReference.name,
    namespace,
  })
  const replicaSetOwner = replicaSet.metadata?.ownerReferences?.[0]
  const resolvedOwner =
    replicaSetOwner?.kind === 'Deployment' && replicaSetOwner.name
      ? `${namespace}/${replicaSetOwner.name}`
      : `${namespace}/${ownerReference.name}`

  cache.set(cacheKey, resolvedOwner)
  return resolvedOwner
}

const selectSourceContainer = (pod: V1Pod, type: SnapshotType): V1Container | null => {
  const containers = pod.spec?.containers || []
  if (containers.length === 0) {
    return null
  }

  if (type === 'elasticsearch') {
    return containers[0]
  }

  const signalNames =
    type === 'mysql' ? ['MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'] : ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']

  const matchingContainers = containers.filter((container) => {
    const envNames = new Set((container.env || []).map((envVar) => envVar.name))
    return signalNames.some((signalName) => envNames.has(signalName)) || (container.envFrom || []).length > 0
  })

  if (matchingContainers.length === 1) {
    return matchingContainers[0]
  }

  return containers[0]
}

const sameSettings = (left: WorkloadSettings, right: WorkloadSettings): boolean => {
  return (
    left.type === right.type &&
    left.schedule === right.schedule &&
    left.timeZone === right.timeZone &&
    left.version === right.version &&
    left.elasticsearchLimit === right.elasticsearchLimit &&
    left.encryptionEnabled === right.encryptionEnabled &&
    left.encryptionRecipient === right.encryptionRecipient
  )
}

const projectEnvVar = (envVars: V1EnvVar[], sourceName: string, targetName: string): V1EnvVar | null => {
  const sourceEnv = envVars.find((envVar) => envVar.name === sourceName)
  if (!sourceEnv) {
    return null
  }

  if (sourceEnv.value !== undefined) {
    return { name: targetName, value: sourceEnv.value }
  }

  if (sourceEnv.valueFrom) {
    return { name: targetName, valueFrom: sourceEnv.valueFrom }
  }

  return null
}

const deleteTerminatedJobs = async (batchApi: BatchV1Api, namespace: string): Promise<void> => {
  const jobs = await batchApi.listNamespacedJob({
    namespace,
    labelSelector,
  })

  for (const job of jobs.items) {
    if (!isFinishedJob(job) || !isOlderThanRetention(job)) {
      continue
    }

    const name = job.metadata?.name
    if (!name) {
      continue
    }

    try {
      console.log(`Deleting old Job ${namespace}/${name}`)
      await batchApi.deleteNamespacedJob({
        name,
        namespace,
      })
    } catch (error) {
      console.error(`Failed to delete old Job ${namespace}/${name}: ${formatError(error)}`)
    }
  }
}

const isFinishedJob = (job: V1Job): boolean => {
  return Boolean(job.status?.succeeded || job.status?.failed)
}

const isOlderThanRetention = (job: V1Job): boolean => {
  const referenceTime =
    job.status?.completionTime || job.status?.startTime || job.metadata?.creationTimestamp
  if (!referenceTime) {
    return false
  }

  return new Date(referenceTime).getTime() + COMPLETED_JOB_RETENTION_SECONDS * 1000 < Date.now()
}

const isRecoverableKubernetesConflict = (error: unknown): boolean => {
  const code =
    typeof error === 'object' && error !== null
      ? 'code' in error && typeof error.code === 'number'
        ? error.code
        : 'body' in error &&
            typeof error.body === 'object' &&
            error.body !== null &&
            'code' in error.body &&
            typeof error.body.code === 'number'
          ? error.body.code
          : undefined
      : undefined

  return code === 409
}

const normalizeDnsLabel = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const formatPodName = (pod: V1Pod): string => {
  return `${pod.metadata?.namespace}/${pod.metadata?.name}`
}

const comparePodNames = (left: V1Pod, right: V1Pod): number => {
  return String(left.metadata?.name).localeCompare(String(right.metadata?.name))
}

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
