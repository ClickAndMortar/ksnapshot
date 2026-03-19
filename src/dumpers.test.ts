import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import test from 'node:test'

const execFileAsync = promisify(execFile)

const workspaceRoot = new URL('..', import.meta.url)
const mysqlScriptPath = new URL('../dumpers/mysql/dump.sh', import.meta.url)
const postgresqlScriptPath = new URL('../dumpers/postgresql/dump.sh', import.meta.url)
const elasticsearchScriptPath = new URL('../dumpers/elasticsearch/dump.sh', import.meta.url)

type StubMap = Record<string, string>

const createStub = async (binDirectory: string, name: string, source: string) => {
  const stubPath = join(binDirectory, name)
  await writeFile(stubPath, source)
  await chmod(stubPath, 0o755)
}

const createStubs = async (binDirectory: string, stubs: StubMap) => {
  for (const [name, source] of Object.entries(stubs)) {
    await createStub(binDirectory, name, source)
  }
}

const runScript = async (scriptPath: URL, env: Record<string, string>, stubs: StubMap) => {
  const testRoot = await mkdtemp(join(tmpdir(), 'ksnapshot-test-'))
  const binDirectory = join(testRoot, 'bin')
  await mkdir(binDirectory)
  await createStubs(binDirectory, stubs)

  try {
    const result = await execFileAsync('/bin/bash', [scriptPath.pathname], {
      cwd: workspaceRoot.pathname,
      env: {
        ...process.env,
        ...env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        TEST_ROOT: testRoot,
      },
    })

    return {
      ...result,
      testRoot,
    }
  } catch (error) {
    throw Object.assign(error as Error, { testRoot })
  }
}

test('mysql dumper accepts native env names and uploads a normalized S3 path', async () => {
  const result = await runScript(
    mysqlScriptPath,
    {
      BACKEND_BUCKET: 'snapshots',
      BACKEND_PATH: '/nested/path/',
      BACKEND_TYPE: 's3',
      HOSTNAME: 'mysql-pod',
      MYSQLDATABASE: '',
      MYSQLDUMP_OPTIONS: '--quick --skip-lock-tables',
      MYSQLDUMP_TABLES: 'orders customers',
      MYSQL_HOST: 'mysql.demo.svc',
      MYSQL_PASSWORD: 'secret value',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'app-user',
      MYSQL_DATABASE: 'catalog',
    },
    {
      mysqldump: `#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "${'$'}{TEST_ROOT}/mysqldump.args"
sleep 1
printf 'mysql dump'
`,
      osm: `#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "${'$'}{TEST_ROOT}/osm.args"
printf -- '--\n' >> "${'$'}{TEST_ROOT}/osm.args"
`,
    }
  )

  const mysqldumpArgs = await readFile(join(result.testRoot, 'mysqldump.args'), 'utf8')
  const osmArgs = await readFile(join(result.testRoot, 'osm.args'), 'utf8')

  assert.match(mysqldumpArgs, /-u\napp-user/)
  assert.match(mysqldumpArgs, /-psecret value/)
  assert.match(mysqldumpArgs, /catalog/)
  assert.match(osmArgs, /push/)
  assert.match(osmArgs, /\/nested\/path\/\d{4}\/\d{2}\/\d{2}\/mysql\//)

  await rm(result.testRoot, { force: true, recursive: true })
})

test('postgresql dumper accepts native env names and uploads to S3', async () => {
  const result = await runScript(
    postgresqlScriptPath,
    {
      BACKEND_BUCKET: 'snapshots',
      BACKEND_PATH: 'postgres/backups',
      BACKEND_TYPE: 's3',
      HOSTNAME: 'postgres-pod',
      POSTGRESQL_HOST: 'postgres.demo.svc',
      POSTGRESQL_PORT: '5432',
      POSTGRES_USER: 'app-user',
      POSTGRES_PASSWORD: 'super-secret',
      POSTGRES_DB: 'catalog',
    },
    {
      pg_dump: `#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "${'$'}{TEST_ROOT}/pg_dump.args"
sleep 1
printf 'postgres dump'
`,
      osm: `#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "${'$'}{TEST_ROOT}/osm.args"
printf -- '--\n' >> "${'$'}{TEST_ROOT}/osm.args"
`,
    }
  )

  const osmArgs = await readFile(join(result.testRoot, 'osm.args'), 'utf8')

  assert.match(result.stdout, /Dumping database catalog from server postgres\.demo\.svc:5432/)
  assert.match(osmArgs, /\/postgres\/backups\/\d{4}\/\d{2}\/\d{2}\/postgresql\//)

  await rm(result.testRoot, { force: true, recursive: true })
})

test('elasticsearch dumper surfaces elasticdump failures', async () => {
  await assert.rejects(
    () =>
      runScript(
        elasticsearchScriptPath,
        {
          ELASTICSEARCH_HOST: 'es.demo.svc',
          ELASTICSEARCH_PORT: '9200',
        },
        {
          curl: `#!/bin/bash
set -euo pipefail
printf '{"version":{"number":"8.11.0"}}'
`,
          jq: `#!/bin/bash
set -euo pipefail
printf '8.11.0'
`,
          semver: `#!/bin/bash
set -euo pipefail
exit 0
`,
          elasticdump: `#!/bin/bash
set -euo pipefail
exit 7
`,
        }
      ),
    /Command failed/
  )
})
