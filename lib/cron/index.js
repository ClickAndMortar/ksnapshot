module.exports = {
    transformScheduleToJobSpec(schedule) {
        return {
            template: {
                spec: {
                    restartPolicy: 'Never',
                    containers: [
                        {
                            name: 'job',
                            image: 'clickandmortar/k8s-mysql-dumper:8',
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
                                }
                            ]
                        }
                    ]
                }
            }
        };
    }
};
