const k8s = require('@kubernetes/client-node')
const https = require('https')
const axios = require('axios')
const k8sClient = require('./lib/k8s')
const CronJob = require('cron').CronJob
const _ = require('lodash')
const kc = new k8s.KubeConfig()

const MODE = process.env.MODE || 'local'

if (MODE === 'local') {
  kc.loadFromDefault()
} else if (MODE === 'cluster') {
  kc.loadFromCluster()
} else {
  console.error('Invalid or missing MODE')
  process.exit(1)
}

const httpsAgent = new https.Agent()
kc.applytoHTTPSOptions(httpsAgent.options)

axios.defaults.httpsAgent = httpsAgent
axios.defaults.baseURL = kc.getCurrentCluster().server

// Workaround as Authorization header in httpsAgent is not used in cluster
if (MODE === 'cluster') {
  axios.defaults.headers.Authorization = httpsAgent.options.headers.Authorization
}

const jobLabelFilters = { 'app.kubernetes.io/managed-by': 'ksnapshot' }

const cronjobs = {}

const looper = () => {
  k8sClient.findSnapshotSchedules().then((res) => {
    const items = res.data.items
    items.forEach((item) => {
      const name = item.metadata.name
      if (cronjobs[name] && cronjobs[name].object.metadata.generation === item.metadata.generation) {
        return
      }

      if (typeof cronjobs[name] === 'undefined') {
        cronjobs[name] = {}
      }

      cronjobs[name].object = _.cloneDeep(item)
      if (cronjobs[name].cron) {
        console.log(`Updating cronjob for ${item.metadata.namespace}/${name} schedule`)
        cronjobs[name].cron.stop()
        delete cronjobs[name].cron
      } else {
        console.log(`Adding cronjob for ${item.metadata.namespace}/${name} schedule`)
      }

      cronjobs[name].cron = new CronJob(item.spec.cronSpec, () => {
        const jobName = `ksnapshot-${name.substring(0, 38)}-${Math.floor(Date.now() / 1000)}`
        console.log(`Running job for schedule ${name} in job [${jobName}]`)
        k8sClient.createJobFromSchedule(item.metadata.namespace, jobName, jobLabelFilters, item)
          .catch((err) => {
            console.error(err)
          })
      }, null, false, 'UTC')
      cronjobs[name].cron.start()
    })

    _.filter(_.keys(cronjobs), (name) => {
      return _.filter(items, (item) => {
        return name === item.metadata.name
      }).length === 0
    }).forEach((name) => {
      console.log(`Removing cronjob ${cronjobs[name].object.metadata.namespace}/${name}`)
      delete cronjobs[name]
    })
  }).catch((err) => {
    console.error(err)
  })

  // Only run every ~5 loops
  if (Math.round(Math.random() * 100) % 5 === 0) {
    k8sClient.deleteTerminatedJobs(jobLabelFilters)
  }

  setTimeout(looper, 10000)
}

process.on('SIGTERM', () => {
  console.log('Terminating')
  process.exit(0)
})

looper()
