module.exports = {
  transformScheduleToJobSpec (schedule) {
    const mysqlExcludedTables = schedule.spec.config.mysql.excludedTables || []
    const mysqlTables = schedule.spec.config.mysql.tables || []

    const image = 'clickandmortar/ksnapshot-dumper'
    let tag = ''
    if (schedule.spec.type === 'mysql') {
      if (schedule.spec.config.mysql.version === '5.7') {
        tag = 'mysql-5.7'
      } else {
        tag = 'mysql-8'
      }
    } else if (schedule.spec.type === 'elasticsearch') {
      tag = 'es'
    } else {
      throw new Error('Unsupported schedule type')
    }

    return {
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'job',
              image: `${image}:${tag}`,
              imagePullPolicy: 'Always',
              env: [
                {
                  name: 'MYSQL_HOST',
                  value: schedule.spec.config.mysql.host
                },
                {
                  name: 'MYSQL_PORT',
                  value: schedule.spec.config.mysql.port.toString()
                },
                {
                  name: 'MYSQL_USERNAME',
                  value: schedule.spec.config.mysql.username
                },
                {
                  name: 'MYSQL_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: schedule.spec.config.mysql.passwordSecretKeyRef.name,
                      key: schedule.spec.config.mysql.passwordSecretKeyRef.key
                    }
                  }
                },
                {
                  name: 'MYSQL_DATABASE',
                  value: schedule.spec.config.mysql.database
                },
                {
                  name: 'MYSQLDUMP_OPTIONS',
                  value: schedule.spec.config.mysql.arguments
                },
                {
                  name: 'MYSQLDUMP_TABLES',
                  value: mysqlTables.join(' ')
                },
                {
                  name: 'MYSQLDUMP_EXCLUDED_TABLES',
                  value: mysqlExcludedTables.join(' ')
                },
                {
                  name: 'MYSQLDUMP_SPLIT_PER_TABLE',
                  value: schedule.spec.config.mysql.splitPerTable === true ? 'true' : 'false'
                },
                {
                  name: 'BACKEND_TYPE',
                  value: schedule.spec.backend.type
                },
                {
                  name: 'BACKEND_S3_ENDPOINT',
                  value: schedule.spec.backend.config.s3Endpoint
                },
                {
                  name: 'BACKEND_S3_REGION',
                  value: schedule.spec.backend.config.region
                },
                {
                  name: 'BACKEND_S3_ACCESS_KEY',
                  value: schedule.spec.backend.config.s3AccessKey
                },
                {
                  name: 'BACKEND_S3_SECRET_KEY',
                  valueFrom: {
                    secretKeyRef: {
                      name: schedule.spec.backend.config.s3SecretKeyRef.name,
                      key: schedule.spec.backend.config.s3SecretKeyRef.key
                    }
                  }
                },
                {
                  name: 'BACKEND_BUCKET',
                  value: schedule.spec.backend.config.bucket
                },
                {
                  name: 'BACKEND_PATH',
                  value: schedule.spec.backend.config.path
                },
                {
                  name: 'ENCRYPTION_ENABLED',
                  value: schedule.spec.encryption.enabled === true ? 'true' : 'false'
                },
                {
                  name: 'ENCRYPTION_RECIPIENT',
                  value: schedule.spec.encryption.recipient
                }
              ],
              resources: schedule.spec.resources || {}
            }
          ]
        }
      }
    }
  }
}
