const axios = require('axios')
const qs = require('qs')
const cron = require('../cron')

module.exports = {
  findSnapshotSchedules () {
    return axios.get('/apis/ksnapshot.clickandmortar.io/v1alpha1/schedules')
  },
  findCronJobs (labels) {
    return axios.get('/apis/batch/v1beta1/cronjobs', { params: { labelSelector: qs.stringify(labels, { encodeValuesOnly: true }) } })
  },
  findJobs (labels) {
    return axios.get('/apis/batch/v1/jobs', { params: { labelSelector: qs.stringify(labels, { encodeValuesOnly: true }) } })
  },
  findPods (labels) {
    return axios.get('/api/v1/pods', { params: { labelSelector: qs.stringify(labels, { encodeValuesOnly: true }) } })
  },
  findCronJob (namespace, name) {
    return axios.get(`/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`)
  },
  findJob (namespace, name) {
    return axios.get(`/apis/batch/v1/namespaces/${namespace}/jobs/${name}`)
  },
  deleteJob (namespace, name) {
    return axios.delete(`/apis/batch/v1/namespaces/${namespace}/jobs/${name}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      data: {
        propagationPolicy: 'Background'
      }
    })
  },
  deletePod (namespace, name) {
    return axios.delete(`/api/v1/namespaces/${namespace}/pods/${name}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      data: {
        propagationPolicy: 'Background'
      }
    })
  },
  deleteTerminatedJobs (labels) {
    const since = 86400
    this.findJobs(labels).then((res) => {
      const jobs = res.data.items
      jobs.forEach((job) => {
        const namespace = job.metadata.namespace
        const jobName = job.metadata.name
        const jobCreationDate = new Date(job.metadata.creationTimestamp)

        // Only delete completed jobs created more than 24 hours ago
        if (job.spec.completions > 0 && (jobCreationDate.getTime() + (since * 1000)) < Date.now()) {
          this.findPods({ 'job-name': jobName }).then((res) => {
            const pods = res.data.items
            pods.forEach((pod) => {
              const podName = pod.metadata.name
              this.deletePod(namespace, podName).then(() => {
                console.log(`Deleted completed Pod ${namespace}/${podName}`)
              }).catch((err) => {
                console.error(`Failed to delete completed Pod ${namespace}/${podName}: ${err}`)
              })
            })
          })
          this.deleteJob(namespace, jobName).then(() => {
            console.log(`Deleted completed Job ${namespace}/${jobName}`)
          }).catch((err) => {
            console.error(`Failed to delete completed Job ${namespace}/${jobName}: ${err}`)
          })
        }
      })
    })
  },
  createCronJob (namespace, name, labels, spec) {
    const url = `/apis/batch/v1beta1/namespaces/${namespace}/cronjobs`
    const data = {
      metadata: {
        name: name,
        labels: labels
      },
      spec: spec
    }

    return axios.post(
      url,
      data
    )
  },
  createJobFromSchedule (namespace, name, labels, schedule) {
    const url = `/apis/batch/v1/namespaces/${namespace}/jobs`
    const data = {
      metadata: {
        name: name,
        labels: labels
      },
      spec: cron.transformScheduleToJobSpec(schedule)
    }

    return axios.post(
      url,
      data
    )
  }
}
