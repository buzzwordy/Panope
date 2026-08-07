import type { PanopeApi } from '../shared/api'

declare global {
  interface Window {
    api: PanopeApi
  }
}

export {}
