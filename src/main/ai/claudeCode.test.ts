import { describe, it, expect } from 'vitest'
import { resultErrorText, isMissingSession } from './claudeCode'
import { recapFromEvents } from './session'
import type { AiEvent } from '../../shared/types'

describe('resultErrorText', () => {
  it('uses the errors list when a run fails before any model turn', () => {
    // what `claude -p --resume <gone>` actually prints as its result event
    const ev = {
      subtype: 'error_during_execution',
      result: undefined,
      errors: ['No conversation found with session ID: 9ce55555-75e5-450b-bf65-fa3758d8878b']
    }
    expect(resultErrorText(ev)).toBe('No conversation found with session ID: 9ce55555-75e5-450b-bf65-fa3758d8878b')
  })

  it('prefers the result text when there is one', () => {
    expect(resultErrorText({ subtype: 'error_max_turns', result: 'hit the turn limit', errors: ['x'] })).toBe(
      'hit the turn limit'
    )
  })

  it('falls back to the subtype, ignoring junk in errors', () => {
    expect(resultErrorText({ subtype: 'error_during_execution', errors: ['', 3] })).toBe(
      'claude exited with error_during_execution'
    )
    expect(resultErrorText({})).toBe('claude exited with an error')
  })
})

describe('isMissingSession', () => {
  it('recognises the CLI message for an expired or unknown session', () => {
    expect(isMissingSession('No conversation found with session ID: abc')).toBe(true)
    expect(isMissingSession('Invalid API key - please run /login')).toBe(false)
    expect(isMissingSession(undefined)).toBe(false)
  })
})

describe('recapFromEvents', () => {
  const chat: AiEvent[] = [
    { type: 'user', text: 'why is web-1 restarting?' },
    { type: 'tool', name: 'get_logs', summary: 'logs default/web-1' },
    { type: 'text', text: 'It is OOM-killed. ' },
    { type: 'text', text: 'Limit is 128Mi.' },
    { type: 'done' },
    { type: 'error', error: 'claude exited with error_during_execution' },
    { type: 'user', text: 'raise it to 256Mi' }
  ]

  it('turns the transcript into user and assistant lines, skipping errors', () => {
    const r = recapFromEvents(chat)
    expect(r).toContain('User: why is web-1 restarting?')
    expect(r).toContain('Assistant: [logs default/web-1] It is OOM-killed. Limit is 128Mi.')
    expect(r).toContain('User: raise it to 256Mi')
    expect(r).not.toContain('error_during_execution')
    expect(r.startsWith('[Earlier in this chat')).toBe(true)
  })

  it('keeps the most recent lines when it has to cut', () => {
    const r = recapFromEvents(chat, 40)
    expect(r).toContain('User: raise it to 256Mi')
    expect(r).not.toContain('why is web-1 restarting')
  })

  it('is empty when there is nothing to recap', () => {
    expect(recapFromEvents([])).toBe('')
    expect(recapFromEvents([{ type: 'error', error: 'x' }])).toBe('')
  })
})
