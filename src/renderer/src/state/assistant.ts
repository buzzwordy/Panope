import { api, isDesktop } from '../api'
import type { AiEvent } from '@shared/types'

/**
 * Assistant transcript, held outside the panel component. The panel is
 * unmounted whenever it is closed; the session in the main process keeps
 * running, so events (including confirmation cards) must land somewhere that
 * survives the unmount. Subscribed once at app start.
 */

export type AssistantBlock =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'confirm'; id: string; name: string; summary: string; args: Record<string, unknown>; resolved?: 'yes' | 'no' }
  | { kind: 'error'; text: string }

export interface AssistantState {
  blocks: AssistantBlock[]
  busy: boolean
}

let state: AssistantState = { blocks: [], busy: false }
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function apply(e: AiEvent): void {
  const blocks = [...state.blocks]
  let busy = state.busy
  switch (e.type) {
    case 'user':
      blocks.push({ kind: 'user', text: e.text })
      break
    case 'text': {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'text') blocks[blocks.length - 1] = { kind: 'text', text: last.text + e.text }
      else blocks.push({ kind: 'text', text: e.text })
      break
    }
    case 'tool':
      blocks.push({ kind: 'tool', name: e.name, summary: e.summary })
      break
    case 'confirm':
      blocks.push({ kind: 'confirm', id: e.id, name: e.name, summary: e.summary, args: e.args })
      break
    // resolution comes from the main process, whichever way it happened:
    // a click here, a timeout, or a stop
    case 'confirmed':
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        if (b.kind === 'confirm' && b.id === e.id) {
          blocks[i] = { ...b, resolved: e.approve ? 'yes' : 'no' }
          break
        }
      }
      break
    case 'error':
      blocks.push({ kind: 'error', text: e.error })
      busy = false
      break
    case 'done':
      busy = false
      break
  }
  state = { blocks, busy }
  notify()
}

let started = false
export function initAssistantStore(): void {
  if (started || !isDesktop) return
  started = true
  // live events can race the history fetch; buffer them and replay after
  const queued: AiEvent[] = []
  let replaying = true
  api.onAiEvent((e) => {
    if (replaying) queued.push(e)
    else apply(e)
  })
  void api
    .aiHistory()
    .then((events) => {
      for (const e of events) apply(e)
    })
    .catch(() => undefined)
    .then(() => {
      replaying = false
      for (const e of queued) apply(e)
    })
}

export function assistantSnapshot(): AssistantState {
  return state
}

export function subscribeAssistant(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function assistantSend(text: string, ctx: { context?: string; namespace?: string; view?: string }): void {
  // the user block arrives back as a 'user' event, so only the flag is set here
  state = { ...state, busy: true }
  notify()
  void api.aiSend(text, ctx)
}

export function assistantStop(): void {
  state = { ...state, busy: false }
  notify()
  void api.aiStop()
}

export function assistantClear(): void {
  state = { blocks: [], busy: false }
  notify()
  void api.aiReset()
}
