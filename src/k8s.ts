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
