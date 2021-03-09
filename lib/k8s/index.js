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
    return axios.get('/apis/batch/v1beta1/jobs', { params: { labelSelector: qs.stringify(labels, { encodeValuesOnly: true }) } })
  },
  findCronJob (namespace, name) {
    return axios.get(`/apis/batch/v1beta1/namespaces/${namespace}/cronjobs/${name}`)
  },
  findJob (namespace, name) {
    return axios.get(`/apis/batch/v1beta1/namespaces/${namespace}/jobs/${name}`)
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
