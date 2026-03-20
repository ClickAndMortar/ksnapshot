import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppsV1Api, V1Pod, V1Service } from '@kubernetes/client-node'
import {
  buildCronJobName,
  buildControllerConfig,
  collectWorkloads,
  extractPlainTextSecrets,
  findMatchingService,
  projectDatabaseEnv,
  selectDumperImage,
} from './controller.js'

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

test('projectDatabaseEnv preserves valueFrom and envFrom references', () => {
  const projection = projectDatabaseEnv(
    {
      env: [
        {
          name: 'POSTGRES_USER',
          valueFrom: {
            secretKeyRef: {
              key: 'username',
              name: 'database-secret',
            },
          },
        },
      ],
      envFrom: [
        {
          secretRef: {
            name: 'database-secret',
          },
        },
      ],
    },
    [['POSTGRES_USER', 'POSTGRESQL_USERNAME']]
  )

  assert.deepEqual(projection.env, [
    {
      name: 'POSTGRESQL_USERNAME',
      valueFrom: {
        secretKeyRef: {
          key: 'username',
          name: 'database-secret',
        },
      },
    },
  ])
  assert.deepEqual(projection.envFrom, [
    {
      secretRef: {
        name: 'database-secret',
      },
    },
  ])
})

test('selectDumperImage chooses the configured image for each supported version', () => {
  const config = buildControllerConfig({
    ELASTICSEARCH_DUMPER_IMAGE: 'elastic:1',
    MYSQL_DUMPER_IMAGE_5_7: 'mysql57:1',
    MYSQL_DUMPER_IMAGE_8: 'mysql8:1',
    POSTGRESQL_DUMPER_IMAGE_16: 'postgres16:1',
  })

  assert.equal(selectDumperImage(config, 'mysql', '5.7'), 'mysql57:1')
  assert.equal(selectDumperImage(config, 'mysql', '8'), 'mysql8:1')
  assert.equal(selectDumperImage(config, 'postgresql', '16'), 'postgres16:1')
  assert.equal(selectDumperImage(config, 'elasticsearch'), 'elastic:1')
  assert.equal(selectDumperImage(config, 'mysql', '5.6'), null)
})

test('extractPlainTextSecrets moves plain-text sensitive vars into secretData', () => {
  const env = [
    { name: 'MYSQL_HOST', value: 'db.example.com' },
    { name: 'MYSQL_PASSWORD', value: 's3cret' },
    { name: 'MYSQL_USERNAME', value: 'app' },
  ]

  const result = extractPlainTextSecrets(env, 'my-cronjob')

  assert.deepEqual(result.secretData, { MYSQL_PASSWORD: 's3cret' })
  assert.equal(result.env.length, 3)
  assert.deepEqual(result.env[0], { name: 'MYSQL_HOST', value: 'db.example.com' })
  assert.deepEqual(result.env[1], {
    name: 'MYSQL_PASSWORD',
    valueFrom: { secretKeyRef: { name: 'my-cronjob', key: 'MYSQL_PASSWORD' } },
  })
  assert.deepEqual(result.env[2], { name: 'MYSQL_USERNAME', value: 'app' })
})

test('extractPlainTextSecrets passes through valueFrom refs unchanged', () => {
  const env = [
    {
      name: 'MYSQL_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'existing-secret', key: 'password' } },
    },
    {
      name: 'POSTGRESQL_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'pg-secret', key: 'password' } },
    },
  ]

  const result = extractPlainTextSecrets(env, 'my-cronjob')

  assert.deepEqual(result.secretData, {})
  assert.deepEqual(result.env, env)
})

test('extractPlainTextSecrets handles mixed plain-text and secretKeyRef passwords', () => {
  const env = [
    { name: 'MYSQL_PASSWORD', value: 'plain-pw' },
    {
      name: 'POSTGRESQL_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'pg-secret', key: 'password' } },
    },
  ]

  const result = extractPlainTextSecrets(env, 'my-cronjob')

  assert.deepEqual(result.secretData, { MYSQL_PASSWORD: 'plain-pw' })
  assert.deepEqual(result.env[0], {
    name: 'MYSQL_PASSWORD',
    valueFrom: { secretKeyRef: { name: 'my-cronjob', key: 'MYSQL_PASSWORD' } },
  })
  assert.deepEqual(result.env[1], {
    name: 'POSTGRESQL_PASSWORD',
    valueFrom: { secretKeyRef: { name: 'pg-secret', key: 'password' } },
  })
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

  const config = buildControllerConfig({})
  const collected = await collectWorkloads([firstPod, secondPod], appsApi, config)

  assert.deepEqual(Array.from(collected.activeOwners), ['demo/database'])
  assert.equal(collected.workloads.length, 1)
  assert.equal(collected.workloads[0]?.owner, 'demo/database')
  assert.equal(collected.workloads[0]?.pods.length, 2)
})
