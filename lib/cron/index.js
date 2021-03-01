const k8s = require('../k8s');

module.exports = {
    createFromSchedule(kss) {
        console.log(kss);
        return k8s.createCronJob(kss.metadata.namespace, `ksnapshot-${kss.metadata.name}`, {
            'app.kubernetes.io/managed-by': 'ksnapshot'
        }, {
            schedule: kss.spec.cronSpec,
            jobTemplate: {
                spec: {
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
                                            value: kss.spec.config.mysql.host
                                        },
                                        {
                                            name: 'MYSQL_PORT',
                                            value: kss.spec.config.mysql.port.toString()
                                        },
                                        {
                                            name: 'MYSQL_USERNAME',
                                            value: kss.spec.config.mysql.username
                                        },
                                        {
                                            name: 'MYSQL_PASSWORD',
                                            valueFrom: {
                                                secretKeyRef: {
                                                    name: kss.spec.config.mysql.passwordSecretKeyRef.name,
                                                    key: kss.spec.config.mysql.passwordSecretKeyRef.key
                                                }
                                            }
                                        },
                                        {
                                            name: 'MYSQL_DATABASE',
                                            value: kss.spec.config.mysql.database
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        });
    }
};
