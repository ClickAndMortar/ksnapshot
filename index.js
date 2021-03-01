const k8s = require('@kubernetes/client-node');
const https = require('https');
const axios = require('axios');
const k8sClient = require('./lib/k8s');
const cron = require('./lib/cron');
const CronJob = require('cron').CronJob;
const CronTime = require('cron').CronTime;
const _ = require('lodash');

const kc = new k8s.KubeConfig();
// kc.loadFromCluster();
kc.loadFromDefault();

const httpsAgent = new https.Agent();
kc.applytoHTTPSOptions(httpsAgent.options);
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

axios.defaults.httpsAgent = httpsAgent;
axios.defaults.baseURL = kc.getCurrentCluster().server;

const jobLabelFilters = {'app.kubernetes.io/managed-by': 'ksnapshot'};

const cronjobs = {};

const looper = () => {
    k8sClient.findSnapshotSchedules().then((res) => {
        let items = res.data.items;
        items.forEach((item) => {
            const name = item.metadata.name;
            if (cronjobs[name] && cronjobs[name].object.metadata.generation === item.metadata.generation) {
                return;
            }

            if (typeof cronjobs[name] === 'undefined') {
                cronjobs[name] = {}
            }

            cronjobs[name].object = _.cloneDeep(item);
            if (cronjobs[name].cron) {
                console.log(`Updating cronjob for ${name}`);
                cronjobs[name].cron.setTime(new CronTime(item.spec.cronSpec, 'UTC'));
            } else {
                console.log(`Adding cronjob for ${name}`);
                cronjobs[name].cron = new CronJob(item.spec.cronSpec, () => {
                    console.log(`Running cron job ${name}`);
                    k8sClient.createOrUpdateJob(item.metadata.namespace, `ksnapshot-${name}-job`, jobLabelFilters, spec)
                }, null, false, 'UTC');
                cronjobs[name].cron.start();
            }
        });

        _.filter(_.keys(cronjobs), (name) => {
            return _.filter(items, (item) => {
                return name === item.metadata.name;
            }).length === 0;
        }).forEach((name) => {
            delete cronjobs[name];
            console.log(`Removing cronjob ${name}`);
        });
    });

    setTimeout(looper, 5000);
}

looper();
//
// loop();
// setInterval(loop, 10000);


// k8sClient.findCronJob(item.metadata.namespace, name).then((res) => {
//     console.log(res.data);
// }).catch((err) => {
//     if (err.response.status === 404) {
//         cron.createFromSchedule(item).catch((err) => {
//             console.log(err);
//         });
//     } else {
//         console.log(err.response.status);
//     }
// });

return;

// k8sClient.createCronJob('staging', 'cj-ksnapshot', {'app.kubernetes.io/managed-by': 'ksnapshot', 'ksnapshot.clickandmortar.io/name': 'name'}, {
//     schedule: '*/5 * * * *',
//     jobTemplate: {
//         spec: {
//             template: {
//                 spec: {
//                     restartPolicy: 'Never',
//                     containers: [
//                         {
//                             name: 'job',
//                             image: 'clickandmortar/k8s-mysql-dumper:8',
//                             imagePullPolicy: 'Always',
//                             // env: [
//                             //     {
//                             //         name: 'MYSQL_HOST',
//                             //         value: ''
//                             //     },
//                             //     {
//                             //         name: 'MYSQL_PORT',
//                             //         value: ''
//                             //     },
//                             //     {
//                             //         name: 'MYSQL_USERNAME',
//                             //         value: ''
//                             //     },
//                             //     {
//                             //         name: 'MYSQL_PASSWORD',
//                             //         valueFrom: {
//                             //             secretKeyRef: {
//                             //                 name: '',
//                             //                 key: ''
//                             //             }
//                             //         }
//                             //     },
//                             //     {
//                             //         name: 'MYSQL_DATABASE',
//                             //         value: ''
//                             //     }
//                             // ]
//                         }
//                     ]
//                 }
//             }
//         }
//     }
// }).then((res) => {
//     console.log(res.body);
// }).catch((err) => {
//     console.log(err);
// });

// request.get(`${kc.getCurrentCluster().server}/apis/ksnapshot.clickandmortar.io/v1alpha1/schedules`, opts,
//     (error, response, body) => {
//         if (error) {
//             console.log(`error: ${error}`);
//             return;
//         }
//
//         body = JSON.parse(body);
//
//         body.items.forEach((item) => {
//             if (item.spec.type === 'mysql') {
//                 k8sApi.readNamespacedSecret(item.spec.config.mysql.passwordSecretKeyRef.name, item.metadata.namespace)
//                     .then((res) => {
//                         const password = res.body.data[item.spec.config.mysql.passwordSecretKeyRef.key];
//                         let buff = Buffer.from(password, 'base64');
//                         let decoded = buff.toString('ascii');
//                         console.log('password is: ' + decoded);
//
//                         // mysqldump({
//                         //     connection: {
//                         //         host: item.spec.config.mysql.host,
//                         //         port: item.spec.config.mysql.port,
//                         //         user: item.spec.config.mysql.username,
//                         //         password: decoded,
//                         //         database: item.spec.config.mysql.database,
//                         //     },
//                         //     dumpToFile: './dump.sql.gz',
//                         //     compressFile: true,
//                         // });
//
//                     })
//                     .catch((err) => {
//                         console.log(err);
//                     })
//                 ;
//             }
//         });
//     });

// k8sApi.listNamespacedPod('monitoring')
//     .then((res) => {
//         let pods = res.body.items;
//
//         pods.forEach((pod) => {
//             console.log(pod.metadata.annotations);
//         })
//     })
//     .catch((err) => {
//         console.log(err);
//     });
