import { buildControllerConfig, LOOP_INTERVAL_MS, reconcileOnce } from './controller.js'
import { k8sAppsApi, k8sBatchApi, k8sCoreApi } from './k8s.js'

const config = buildControllerConfig()
let timer: NodeJS.Timeout | undefined

const scheduleNext = () => {
  timer = setTimeout(() => {
    void loop()
  }, LOOP_INTERVAL_MS)
}

const loop = async () => {
  try {
    await reconcileOnce(
      {
        appsApi: k8sAppsApi,
        batchApi: k8sBatchApi,
        coreApi: k8sCoreApi,
      },
      config
    )
  } catch (error) {
    console.error(`Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    scheduleNext()
  }
}

const terminate = (signal: string) => {
  if (timer) {
    clearTimeout(timer)
  }

  console.log(`${signal}, terminating`)
  process.exit(0)
}

process.on('SIGINT', () => terminate('SIGINT'))
process.on('SIGTERM', () => terminate('SIGTERM'))

await loop()
