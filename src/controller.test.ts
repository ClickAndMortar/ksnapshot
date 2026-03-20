import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppsV1Api, BatchV1Api, CoreV1Api, V1CronJob, V1Pod, V1Service } from '@kubernetes/client-node'
import {
  buildCredentialSecretName,
  buildCronJobName,
  buildControllerConfig,
  collectWorkloads,
  findMatchingService,
  reconcileOnce,
  resolveDatabaseCredentials,
  selectDumperImage,
} from './controller.js'
import { getAnnotation } from './utils.js'

const buildTestConfig = (overrides: NodeJS.ProcessEnv = {}) =>
  buildControllerConfig({
    ELASTICSEARCH_DUMPER_IMAGE: 'elastic:1',
    MYSQL_DUMPER_IMAGE_5_7: 'mysql57:1',
    MYSQL_DUMPER_IMAGE_8: 'mysql8:1',
    POSTGRESQL_DUMPER_IMAGE_16: 'postgres16:1',
    WATCH_NAMESPACES: 'default',
    ...overrides,
  })

const encodeSecretData = (data: Record<string, string>): Record<string, string> => {
  const encoded: Record<string, string> = {}

  for (const [key, value] of Object.entries(data)) {
    encoded[key] = Buffer.from(value, 'utf8').toString('base64')
  }

  return encoded
}

test('buildCronJobName is deterministic and collision-resistant for long owners', () => {
  const first = buildCronJobName('mysql', 'team-a/really-long-workload-name-aaaaaaaaaaaaaaaaaaaa')
  const second = buildCronJobName('mysql', 'team-a/really-long-workload-name-bbbbbbbbbbbbbbbbbbbb')

  assert.notEqual(first, second)
  assert.ok(first.startsWith('ksnapshot-mysql-'))
  assert.ok(first.length <= 52)
})

test('findMatchingService ignores selectorless Services and rejects ambiguous matches', () => {
  const pod = {
    metadata: {
      labels: {
        app: 'database',
        tier: 'primary',
      },
      name: 'db-0',
      namespace: 'demo',
    },
  } as unknown as V1Pod

  const selectorless = {
    metadata: { name: 'manual-service', namespace: 'demo' },
    spec: {},
  } as V1Service
  const primary = {
    metadata: { name: 'primary-service', namespace: 'demo' },
    spec: { selector: { app: 'database' } },
  } as V1Service
  const secondary = {
    metadata: { name: 'secondary-service', namespace: 'demo' },
    spec: { selector: { app: 'database', tier: 'primary' } },
  } as V1Service

  const noMatch = findMatchingService([selectorless], [pod])
  assert.equal(noMatch.service, undefined)
  assert.match(String(noMatch.error), /No selector-based Service/)

  const ambiguous = findMatchingService([selectorless, primary, secondary], [pod])
  assert.equal(ambiguous.service, undefined)
  assert.match(String(ambiguous.error), /Multiple selector-based Services/)

  const exact = findMatchingService([selectorless, secondary], [pod])
  assert.equal(exact.service?.metadata?.name, 'secondary-service')
})

test('buildControllerConfig requires non-empty watch namespaces and trims values', () => {
  assert.throws(() => buildControllerConfig({}), /WATCH_NAMESPACES must contain at least one namespace/)

  const config = buildTestConfig({ WATCH_NAMESPACES: ' team-a , team-b ' })
  assert.deepEqual(config.watchNamespaces, ['team-a', 'team-b'])
})

test('selectDumperImage chooses the configured image for each supported version', () => {
  const config = buildTestConfig()

  assert.equal(selectDumperImage(config, 'mysql', '5.7'), 'mysql57:1')
  assert.equal(selectDumperImage(config, 'mysql', '8'), 'mysql8:1')
  assert.equal(selectDumperImage(config, 'postgresql', '16'), 'postgres16:1')
  assert.equal(selectDumperImage(config, 'elasticsearch'), 'elastic:1')
  assert.equal(selectDumperImage(config, 'mysql', '5.6'), null)
})

test('resolveDatabaseCredentials mirrors supported env sources with env precedence', async () => {
  const coreApi = {
    readNamespacedConfigMap: async ({ name }: { name: string }) => {
      if (name === 'database-config') {
        return {
          data: {
            MYSQL_DATABASE: 'catalog-from-configmap',
          },
        }
      }

      throw new Error(`unexpected configmap ${name}`)
    },
    readNamespacedSecret: async ({ name }: { name: string }) => {
      if (name === 'base-secret') {
        return {
          data: encodeSecretData({
            MYSQL_DATABASE: 'catalog-from-secret',
            MYSQL_USER: 'user-from-envfrom',
          }),
        }
      }

      if (name === 'user-secret') {
        return {
          data: encodeSecretData({
            username: 'user-from-secretref',
          }),
        }
      }

      if (name === 'password-secret') {
        return {
          data: encodeSecretData({
            password: 'password-from-secretref',
          }),
        }
      }

      throw new Error(`unexpected secret ${name}`)
    },
  } as unknown as Pick<CoreV1Api, 'readNamespacedConfigMap' | 'readNamespacedSecret'>

  const resolved = await resolveDatabaseCredentials(
    coreApi,
    'demo',
    {
      env: [
        {
          name: 'MYSQL_USER',
          valueFrom: {
            secretKeyRef: {
              key: 'username',
              name: 'user-secret',
            },
          },
        },
        {
          name: 'MYSQL_PASSWORD',
          valueFrom: {
            secretKeyRef: {
              key: 'password',
              name: 'password-secret',
            },
          },
        },
        {
          name: 'MYSQL_DATABASE',
          value: 'catalog-from-env',
        },
      ],
      envFrom: [
        {
          secretRef: {
            name: 'base-secret',
          },
        },
        {
          configMapRef: {
            name: 'database-config',
          },
        },
        {
          prefix: 'IGNORED_',
          secretRef: {
            name: 'base-secret',
          },
        },
      ],
    },
    [
      ['MYSQL_USER', 'MYSQL_USERNAME'],
      ['MYSQL_PASSWORD', 'MYSQL_PASSWORD'],
      ['MYSQL_DATABASE', 'MYSQL_DATABASE'],
    ]
  )

  assert.deepEqual(resolved, {
    MYSQL_DATABASE: 'catalog-from-env',
    MYSQL_PASSWORD: 'password-from-secretref',
    MYSQL_USERNAME: 'user-from-secretref',
  })
})

test('resolveDatabaseCredentials rejects unsupported env sources for mirrored keys', async () => {
  const coreApi = {
    readNamespacedConfigMap: async () => ({ data: {} }),
    readNamespacedSecret: async () => ({ data: {} }),
  } as unknown as Pick<CoreV1Api, 'readNamespacedConfigMap' | 'readNamespacedSecret'>

  await assert.rejects(
    () =>
      resolveDatabaseCredentials(
        coreApi,
        'demo',
        {
          env: [
            {
              name: 'MYSQL_PASSWORD',
              valueFrom: {
                fieldRef: {
                  apiVersion: 'v1',
                  fieldPath: 'metadata.name',
                },
              },
            },
          ],
        },
        [['MYSQL_PASSWORD', 'MYSQL_PASSWORD']]
      ),
    /Unsupported source for MYSQL_PASSWORD: fieldRef/
  )
})

test('collectWorkloads deduplicates multiple pods under the same resolved owner', async () => {
  const basePod = {
    metadata: {
      annotations: {
        'ksnapshot.clickandmortar.fr/enabled': 'true',
        'ksnapshot.clickandmortar.fr/schedule': '0 3 * * *',
        'ksnapshot.clickandmortar.fr/type': 'mysql',
      },
      namespace: 'demo',
      ownerReferences: [
        {
          kind: 'ReplicaSet',
          name: 'database-rs',
        },
      ],
    },
    spec: {
      containers: [
        {
          env: [
            { name: 'MYSQL_USER', value: 'app' },
            { name: 'MYSQL_PASSWORD', value: 'secret' },
            { name: 'MYSQL_DATABASE', value: 'catalog' },
          ],
        },
      ],
    },
    status: {
      phase: 'Running',
    },
  } as unknown as V1Pod

  const firstPod = {
    ...basePod,
    metadata: {
      ...basePod.metadata,
      name: 'database-0',
    },
  } as unknown as V1Pod
  const secondPod = {
    ...basePod,
    metadata: {
      ...basePod.metadata,
      name: 'database-1',
    },
  } as V1Pod

  const appsApi = {
    readNamespacedReplicaSet: async () => {
      return {
        metadata: {
          ownerReferences: [
            {
              kind: 'Deployment',
              name: 'database',
            },
          ],
        },
      }
    },
  } as unknown as AppsV1Api

  const collected = await collectWorkloads([firstPod, secondPod], appsApi, buildTestConfig())

  assert.deepEqual(Array.from(collected.activeOwners), ['demo/database'])
  assert.equal(collected.workloads.length, 1)
  assert.equal(collected.workloads[0]?.owner, 'demo/database')
  assert.equal(collected.workloads[0]?.pods.length, 2)
})

test('reconcileOnce only lists pods from configured watch namespaces', async () => {
  const listedNamespaces: string[] = []

  const coreApi = {
    deleteNamespacedSecret: async () => undefined,
    listNamespacedPod: async ({ namespace }: { namespace: string }) => {
      listedNamespaces.push(namespace)
      return { items: [] }
    },
    listNamespacedService: async () => ({ items: [] }),
    listPodForAllNamespaces: async () => {
      throw new Error('listPodForAllNamespaces should not be called')
    },
    readNamespacedConfigMap: async () => ({ data: {} }),
    readNamespacedSecret: async () => ({ data: {} }),
  } as unknown as CoreV1Api

  const batchApi = {
    listNamespacedCronJob: async () => ({ items: [] }),
    listNamespacedJob: async () => ({ items: [] }),
  } as unknown as BatchV1Api

  await reconcileOnce(
    {
      appsApi: {} as AppsV1Api,
      batchApi,
      coreApi,
    },
    buildTestConfig({ WATCH_NAMESPACES: 'team-a,team-b' })
  )

  assert.deepEqual(listedNamespaces, ['team-a', 'team-b'])
})

test('reconcileOnce deletes stale CronJobs and mirrored Secrets when workload type changes', async () => {
  const owner = 'demo/database'
  const oldCronJobName = buildCronJobName('mysql', owner)
  const newCronJobName = buildCronJobName('elasticsearch', owner)
  const createdCronJobs: string[] = []
  const deletedCronJobs: string[] = []
  const deletedSecrets: string[] = []

  const coreApi = {
    deleteNamespacedSecret: async ({ name }: { name: string }) => {
      deletedSecrets.push(name)
      return undefined
    },
    listNamespacedPod: async () => ({
      items: [
        {
          metadata: {
            annotations: {
              [getAnnotation('enabled')]: 'true',
              [getAnnotation('schedule')]: '0 2 * * *',
              [getAnnotation('type')]: 'elasticsearch',
            },
            labels: {
              app: 'database',
            },
            name: 'database-0',
            namespace: 'demo',
            ownerReferences: [
              {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                name: 'database',
                uid: 'test-uid',
              },
            ],
          },
          spec: {
            containers: [{ name: 'main' }],
          },
          status: {
            phase: 'Running',
          },
        } as V1Pod,
      ],
    }),
    listNamespacedService: async () => ({
      items: [
        {
          metadata: {
            name: 'database',
            namespace: 'demo',
          },
          spec: {
            selector: {
              app: 'database',
            },
          },
        } as V1Service,
      ],
    }),
    readNamespacedConfigMap: async () => ({ data: {} }),
    readNamespacedSecret: async () => ({ data: {} }),
  } as unknown as CoreV1Api

  const batchApi = {
    createNamespacedCronJob: async ({ body }: { body: V1CronJob }) => {
      createdCronJobs.push(String(body.metadata?.name))
      return body
    },
    deleteNamespacedCronJob: async ({ name }: { name: string }) => {
      deletedCronJobs.push(name)
      return undefined
    },
    listNamespacedCronJob: async () => ({
      items: [
        {
          metadata: {
            annotations: {
              [getAnnotation('owner')]: owner,
            },
            name: oldCronJobName,
          },
        } as V1CronJob,
      ],
    }),
    listNamespacedJob: async () => ({ items: [] }),
  } as unknown as BatchV1Api

  await reconcileOnce(
    {
      appsApi: {} as AppsV1Api,
      batchApi,
      coreApi,
    },
    buildTestConfig({ WATCH_NAMESPACES: 'demo' })
  )

  assert.deepEqual(createdCronJobs, [newCronJobName])
  assert.deepEqual(deletedCronJobs, [oldCronJobName])
  assert.ok(deletedSecrets.includes(oldCronJobName))
  assert.ok(deletedSecrets.includes(buildCredentialSecretName(oldCronJobName)))
})
