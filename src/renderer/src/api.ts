import type { PanopeApi } from '@shared/api'
import { webApi } from './webApi'

/**
 * One entry point for the whole renderer, whichever way it is hosted:
 *  - Electron - the preload bridge has already put the IPC implementation on
 *    `window.api`;
 *  - in-cluster server - no bridge exists, so fall back to the HTTP/WebSocket
 *    implementation.
 * Nothing else in the renderer knows or cares which transport it got.
 */
export const isDesktop = typeof window !== 'undefined' && !!window.api

export const api: PanopeApi = isDesktop ? window.api : webApi
