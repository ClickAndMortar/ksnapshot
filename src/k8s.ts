import qs from 'qs'
import * as k8s from '@kubernetes/client-node'

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

export const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api)
export const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api)
export const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api)

export default {
  findJobs(labels: Record<string, string>) {
    return k8sBatchApi.listJobForAllNamespaces({
      labelSelector: qs.stringify(labels, { encodeValuesOnly: true }),
    })
  },
  deleteJob(namespace: string, name: string) {
    return k8sBatchApi.deleteNamespacedJob({ name, namespace })
  },
  deleteTerminatedJobs(labels: Record<string, string>) {
    const since = 86400
    this.findJobs(labels).then((res) => {
      const jobs = res.items
      jobs.forEach((job: k8s.V1Job) => {
        const namespace = job.metadata?.namespace as string
        const jobName = job.metadata?.name as string
        const jobCreationDate = new Date(String(job.metadata?.creationTimestamp))

        // Only delete completed jobs created more than 24 hours ago
        if (
          job.spec?.completions &&
          job.spec?.completions > 0 &&
          jobCreationDate.getTime() + since * 1000 < Date.now()
        ) {
          this.deleteJob(namespace, jobName)
            .then(() => {
              console.log(`Deleted completed Job ${namespace}/${jobName}`)
            })
            .catch((err) => {
              console.error(`Failed to delete completed Job ${namespace}/${jobName}: ${err}`)
            })
        }
      })
    })
  },
}
