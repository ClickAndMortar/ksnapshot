import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  V1ConfigMap,
  V1Container,
  V1CronJob,
  V1EnvVar,
  V1Job,
  V1Pod,
  V1Secret,
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
const CREDENTIAL_SECRET_SUFFIX = '-credentials'

type SnapshotType = 'mysql' | 'postgresql' | 'elasticsearch'

export const labelFilters = { 'app.kubernetes.io/managed-by': 'ksnapshot' }
export const labelSelector = qs.stringify(labelFilters, { encodeValuesOnly: true })

export interface ControllerConfig {
  controlNamespace: string
  watchNamespaces: string[]
  backupConfigMapName: string
  backupSecretName: string
  backupJobServiceAccountName: string
  backupImagePullPolicy: string
  defaultEncryptionEnabled: boolean
  defaultEncryptionRecipient: string
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

interface ServiceMatchResult {
  service?: V1Service
  error?: string
}

interface ResourceReader {
  readConfigMap(namespace: string, name: string, optional?: boolean): Promise<Record<string, string> | null>
  readSecret(namespace: string, name: string, optional?: boolean): Promise<Record<string, string> | null>
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

const defaultImageTag = (() => {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
    return packageJson.version || 'dev'
  } catch {
    return 'dev'
  }
})()

const defaultImageRef = (repository: string): string => `${repository}:${defaultImageTag}`

const parseWatchNamespaces = (value?: string): string[] => {
  return (value || '')
    .split(',')
    .map((namespace) => namespace.trim())
    .filter(Boolean)
}

export const buildControllerConfig = (env: NodeJS.ProcessEnv = process.env): ControllerConfig => {
  const watchNamespaces = parseWatchNamespaces(env.WATCH_NAMESPACES)
  if (watchNamespaces.length === 0) {
    throw new Error('WATCH_NAMESPACES must contain at least one namespace')
  }

  return {
    controlNamespace: env.CONTROL_NAMESPACE || 'ksnapshot',
    watchNamespaces,
    backupConfigMapName: env.BACKUP_CONFIGMAP_NAME || 'ksnapshot-cm',
    backupSecretName: env.BACKUP_SECRET_NAME || '',
    backupJobServiceAccountName: env.BACKUP_JOB_SERVICE_ACCOUNT_NAME || 'ksnapshot-backup-sa',
    backupImagePullPolicy: env.BACKUP_IMAGE_PULL_POLICY || 'IfNotPresent',
    defaultEncryptionEnabled: env.DEFAULT_ENCRYPTION_ENABLED === 'true',
    defaultEncryptionRecipient: env.DEFAULT_ENCRYPTION_RECIPIENT || '',
    images: {
      mysql57: env.MYSQL_DUMPER_IMAGE_5_7 || defaultImageRef('ghcr.io/clickandmortar/ksnapshot-dumper-mysql-5.7'),
      mysql8: env.MYSQL_DUMPER_IMAGE_8 || defaultImageRef('ghcr.io/clickandmortar/ksnapshot-dumper-mysql-8'),
      postgresql16:
        env.POSTGRESQL_DUMPER_IMAGE_16 ||
        defaultImageRef('ghcr.io/clickandmortar/ksnapshot-dumper-postgresql-16'),
      elasticsearch: env.ELASTICSEARCH_DUMPER_IMAGE || defaultImageRef('ghcr.io/clickandmortar/ksnapshot-dumper-elasticsearch'),
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

export const buildCredentialSecretName = (cronJobName: string): string => `${cronJobName}${CREDENTIAL_SECRET_SUFFIX}`

const buildMirroredCredentialEnv = (
  secretName: string,
  mappings: ReadonlyArray<[string, string]>,
  data: Record<string, string>
): V1EnvVar[] => {
  return mappings.flatMap(([, targetName]) =>
    data[targetName] === undefined
      ? []
      : [
          {
            name: targetName,
            valueFrom: {
              secretKeyRef: {
                key: targetName,
                name: secretName,
              },
            },
          },
        ]
  )
}

const reconcileCredentialSecret = async (
  coreApi: CoreV1Api,
  name: string,
  namespace: string,
  data: Record<string, string>
): Promise<void> => {
  const secret: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, labels: labelFilters },
    stringData: data,
  }
  try {
    await coreApi.readNamespacedSecret({ name, namespace })
    await coreApi.replaceNamespacedSecret({ name, namespace, body: secret })
  } catch {
    await coreApi.createNamespacedSecret({ namespace, body: secret })
  }
}

const deleteCredentialSecret = async (coreApi: CoreV1Api, name: string, namespace: string): Promise<void> => {
  try {
    await coreApi.deleteNamespacedSecret({ name, namespace })
  } catch {
    // Ignore errors (e.g. 404 if Secret doesn't exist)
  }
}

const deleteCredentialSecrets = async (coreApi: CoreV1Api, cronJobName: string, namespace: string): Promise<void> => {
  const names = new Set([cronJobName, buildCredentialSecretName(cronJobName)])

  for (const name of names) {
    await deleteCredentialSecret(coreApi, name, namespace)
  }
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
  const resourceReader = createResourceReader(apis.coreApi)
  const desiredCronJobNames = new Set<string>()

  const lists = await Promise.all(config.watchNamespaces.map((namespace) => apis.coreApi.listNamespacedPod({ namespace })))
  const allPods = lists.flatMap((list) => list.items)
  const { workloads } = await collectWorkloads(allPods, apis.appsApi, config)
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
      const credentialSecretName = buildCredentialSecretName(cronJobName)
      const existingCronJob = existingCronJobsByName.get(cronJobName)
      const credentialSecretData =
        workload.type === 'mysql'
          ? await resolveDatabaseCredentialsWithReader(resourceReader, workload.namespace, workload.sourceContainer, mysqlEnvMappings)
          : workload.type === 'postgresql'
            ? await resolveDatabaseCredentialsWithReader(
                resourceReader,
                workload.namespace,
                workload.sourceContainer,
                postgresqlEnvMappings
              )
            : {}

      if (workload.type === 'mysql') {
        validateResolvedCredentials(workload.type, credentialSecretData, ['MYSQL_USERNAME', 'MYSQL_DATABASE'])
      } else if (workload.type === 'postgresql') {
        validateResolvedCredentials(workload.type, credentialSecretData, [
          'POSTGRESQL_USERNAME',
          'POSTGRESQL_PASSWORD',
          'POSTGRESQL_DATABASE',
        ])
      }

      const snapshotCronJob = buildSnapshotCronJob(
        config,
        workload,
        match.service,
        credentialSecretName,
        credentialSecretData,
        existingCronJob
      )

      desiredCronJobNames.add(cronJobName)

      if (Object.keys(credentialSecretData).length > 0) {
        await reconcileCredentialSecret(apis.coreApi, credentialSecretName, config.controlNamespace, credentialSecretData)
      } else {
        await deleteCredentialSecrets(apis.coreApi, cronJobName, config.controlNamespace)
      }

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
    if (!name || desiredCronJobNames.has(name)) {
      continue
    }

    try {
      console.log(`Deleting orphan CronJob ${config.controlNamespace}/${name}`)
      await apis.batchApi.deleteNamespacedCronJob({
        name,
        namespace: config.controlNamespace,
      })
      await deleteCredentialSecrets(apis.coreApi, name, config.controlNamespace)
    } catch (error) {
      console.error(`Failed to delete orphan CronJob ${config.controlNamespace}/${name}: ${formatError(error)}`)
    }
  }

  await deleteTerminatedJobs(apis.batchApi, config.controlNamespace)
}

export const collectWorkloads = async (
  pods: V1Pod[],
  appsApi: AppsV1Api,
  config: ControllerConfig
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
      const settings = normalizeWorkloadSettings(pod, config)
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
  credentialSecretName: string,
  credentialSecretData: Record<string, string>,
  existingCronJob?: V1CronJob
): V1CronJob => {
  const env = buildBackendEnv(config)
  const serviceHost = `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`

  if (workload.type === 'mysql') {
    env.push(
      { name: 'MYSQL_HOST', value: serviceHost },
      { name: 'MYSQL_PORT', value: '3306' },
      ...buildMirroredCredentialEnv(credentialSecretName, mysqlEnvMappings, credentialSecretData)
    )
  }

  if (workload.type === 'postgresql') {
    env.push(
      { name: 'POSTGRESQL_HOST', value: serviceHost },
      { name: 'POSTGRESQL_PORT', value: '5432' },
      ...buildMirroredCredentialEnv(credentialSecretName, postgresqlEnvMappings, credentialSecretData)
    )
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

const normalizeWorkloadSettings = (pod: V1Pod, config: ControllerConfig): Omit<WorkloadSettings, 'owner' | 'namespace'> | null => {
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

  const encryptionEnabledAnnotation = annotations[getAnnotation('encryption-enabled')]
  const encryptionRecipientAnnotation = annotations[getAnnotation('encryption-recipient')]

  const encryptionEnabled =
    encryptionEnabledAnnotation !== undefined
      ? encryptionEnabledAnnotation === 'true'
      : config.defaultEncryptionEnabled
  const encryptionRecipient = encryptionRecipientAnnotation || config.defaultEncryptionRecipient || undefined

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

const createResourceReader = (
  coreApi: Pick<CoreV1Api, 'readNamespacedConfigMap' | 'readNamespacedSecret'>
): ResourceReader => {
  const configMapCache = new Map<string, Promise<Record<string, string> | null>>()
  const secretCache = new Map<string, Promise<Record<string, string> | null>>()

  return {
    readConfigMap: async (namespace: string, name: string, optional = false) => {
      const data = await getCachedResource(configMapCache, `${namespace}/${name}`, async () => {
        try {
          const configMap = await coreApi.readNamespacedConfigMap({ name, namespace })
          return extractConfigMapData(configMap)
        } catch (error) {
          if (getKubernetesErrorCode(error) === 404) {
            return null
          }

          throw error
        }
      })

      if (!data && !optional) {
        throw new Error(`Referenced ConfigMap ${namespace}/${name} was not found`)
      }

      return data
    },
    readSecret: async (namespace: string, name: string, optional = false) => {
      const data = await getCachedResource(secretCache, `${namespace}/${name}`, async () => {
        try {
          const secret = await coreApi.readNamespacedSecret({ name, namespace })
          return extractSecretData(secret)
        } catch (error) {
          if (getKubernetesErrorCode(error) === 404) {
            return null
          }

          throw error
        }
      })

      if (!data && !optional) {
        throw new Error(`Referenced Secret ${namespace}/${name} was not found`)
      }

      return data
    },
  }
}

export const resolveDatabaseCredentials = async (
  coreApi: Pick<CoreV1Api, 'readNamespacedConfigMap' | 'readNamespacedSecret'>,
  namespace: string,
  container: Pick<V1Container, 'env' | 'envFrom'>,
  mappings: ReadonlyArray<[string, string]>
): Promise<Record<string, string>> => {
  return resolveDatabaseCredentialsWithReader(createResourceReader(coreApi), namespace, container, mappings)
}

const resolveDatabaseCredentialsWithReader = async (
  reader: ResourceReader,
  namespace: string,
  container: Pick<V1Container, 'env' | 'envFrom'>,
  mappings: ReadonlyArray<[string, string]>
): Promise<Record<string, string>> => {
  const resolved = new Map<string, string>()
  const sourceNames = new Set(mappings.map(([sourceName]) => sourceName))

  for (const envFromSource of container.envFrom || []) {
    if (envFromSource.prefix) {
      continue
    }

    if (envFromSource.secretRef?.name) {
      const data = await reader.readSecret(
        namespace,
        envFromSource.secretRef.name,
        envFromSource.secretRef.optional === true
      )
      mergeResolvedEnvFromData(resolved, sourceNames, data)
      continue
    }

    if (envFromSource.configMapRef?.name) {
      const data = await reader.readConfigMap(
        namespace,
        envFromSource.configMapRef.name,
        envFromSource.configMapRef.optional === true
      )
      mergeResolvedEnvFromData(resolved, sourceNames, data)
    }
  }

  for (const envVar of container.env || []) {
    if (!sourceNames.has(envVar.name)) {
      continue
    }

    if (envVar.value !== undefined) {
      resolved.set(envVar.name, envVar.value)
      continue
    }

    const resolvedValue = await resolveExplicitEnvValue(reader, namespace, envVar)
    if (resolvedValue === undefined) {
      resolved.delete(envVar.name)
      continue
    }

    resolved.set(envVar.name, resolvedValue)
  }

  const secretData: Record<string, string> = {}
  for (const [sourceName, targetName] of mappings) {
    const value = resolved.get(sourceName)
    if (value !== undefined) {
      secretData[targetName] = value
    }
  }

  return secretData
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
  return getKubernetesErrorCode(error) === 409
}

const getKubernetesErrorCode = (error: unknown): number | undefined => {
  return typeof error === 'object' && error !== null
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
}

const extractConfigMapData = (configMap: V1ConfigMap): Record<string, string> => {
  return { ...(configMap.data || {}) }
}

const extractSecretData = (secret: V1Secret): Record<string, string> => {
  const data: Record<string, string> = {}

  for (const [key, value] of Object.entries(secret.data || {})) {
    data[key] = Buffer.from(value, 'base64').toString('utf8')
  }

  return data
}

const getCachedResource = async <T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> => {
  let pending = cache.get(key)
  if (!pending) {
    pending = load()
    cache.set(key, pending)
  }

  return pending
}

const mergeResolvedEnvFromData = (
  resolved: Map<string, string>,
  sourceNames: Set<string>,
  data: Record<string, string> | null
): void => {
  if (!data) {
    return
  }

  for (const sourceName of sourceNames) {
    const value = data[sourceName]
    if (value !== undefined) {
      resolved.set(sourceName, value)
    }
  }
}

const resolveExplicitEnvValue = async (
  reader: ResourceReader,
  namespace: string,
  envVar: V1EnvVar
): Promise<string | undefined> => {
  const valueFrom = envVar.valueFrom
  if (!valueFrom) {
    return undefined
  }

  if (valueFrom.secretKeyRef?.name) {
    return resolveSecretKeyRef(reader, namespace, envVar.name, valueFrom.secretKeyRef)
  }

  if (valueFrom.configMapKeyRef?.name) {
    return resolveConfigMapKeyRef(reader, namespace, envVar.name, valueFrom.configMapKeyRef)
  }

  if (valueFrom.fieldRef) {
    throw new Error(`Unsupported source for ${envVar.name}: fieldRef`)
  }

  if (valueFrom.resourceFieldRef) {
    throw new Error(`Unsupported source for ${envVar.name}: resourceFieldRef`)
  }

  throw new Error(`Unsupported source for ${envVar.name}`)
}

const resolveSecretKeyRef = async (
  reader: ResourceReader,
  namespace: string,
  envName: string,
  ref: { key: string; name?: string; optional?: boolean }
): Promise<string | undefined> => {
  if (!ref.name) {
    throw new Error(`Secret reference for ${envName} is missing a name`)
  }

  const data = await reader.readSecret(namespace, ref.name, ref.optional === true)
  if (!data) {
    return undefined
  }

  const value = data[ref.key]
  if (value === undefined) {
    if (ref.optional === true) {
      return undefined
    }

    throw new Error(`Referenced Secret ${namespace}/${ref.name} is missing key ${ref.key} for ${envName}`)
  }

  return value
}

const resolveConfigMapKeyRef = async (
  reader: ResourceReader,
  namespace: string,
  envName: string,
  ref: { key: string; name?: string; optional?: boolean }
): Promise<string | undefined> => {
  if (!ref.name) {
    throw new Error(`ConfigMap reference for ${envName} is missing a name`)
  }

  const data = await reader.readConfigMap(namespace, ref.name, ref.optional === true)
  if (!data) {
    return undefined
  }

  const value = data[ref.key]
  if (value === undefined) {
    if (ref.optional === true) {
      return undefined
    }

    throw new Error(`Referenced ConfigMap ${namespace}/${ref.name} is missing key ${ref.key} for ${envName}`)
  }

  return value
}

const validateResolvedCredentials = (
  type: Extract<SnapshotType, 'mysql' | 'postgresql'>,
  data: Record<string, string>,
  requiredKeys: string[]
): void => {
  const missingKeys = requiredKeys.filter((key) => data[key] === undefined)
  if (missingKeys.length > 0) {
    throw new Error(`Missing required ${type} credential(s): ${missingKeys.join(', ')}`)
  }
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
