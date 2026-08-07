import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chat, type ProviderSettings } from './provider'

/**
 * Drives both wire protocols against a local SSE server, exactly the bytes the
 * real endpoints send: text deltas, streamed tool-call argument fragments.
 */

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

function serve(body: (path: string) => string[]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const line of body(req.url ?? '')) res.write(`data: ${line}\n\n`)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port)
    })
  })
}

const noSignal = new AbortController().signal

describe('openai-compatible client', () => {
  it('streams text and assembles tool calls from argument fragments', async () => {
    const port = await serve(() => [
      JSON.stringify({ choices: [{ delta: { content: 'check' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'ing' } }] }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_resources', arguments: '{"key":' } }] } }
        ]
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pods"}' } }] } }]
      }),
      '[DONE]'
    ])
    const cfg: ProviderSettings = { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }
    const chunks: string[] = []
    const res = await chat(cfg, 'sys', [{ role: 'user', text: 'hi' }], [], (t) => chunks.push(t), noSignal)
    expect(chunks.join('')).toBe('checking')
    expect(res.text).toBe('checking')
    expect(res.calls).toEqual([{ id: 'c1', name: 'list_resources', args: { key: 'pods' } }])
  })

  it('surfaces HTTP errors with the body message', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
    })
    const port = await new Promise<number>((r) =>
      server!.listen(0, '127.0.0.1', () => r((server!.address() as { port: number }).port))
    )
    const cfg: ProviderSettings = { provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }
    await expect(chat(cfg, 's', [{ role: 'user', text: 'x' }], [], () => {}, noSignal)).rejects.toThrow(/401.*bad key/)
  })
})

describe('anthropic client', () => {
  it('streams text and assembles tool_use blocks from json deltas', async () => {
    const port = await serve(() => [
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'looking' } }),
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'get_resource' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"key":"pods",' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"name":"api-0"}' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_stop' })
    ])
    const cfg: ProviderSettings = { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'm', apiKey: 'k' }
    const chunks: string[] = []
    const res = await chat(cfg, 'sys', [{ role: 'user', text: 'hi' }], [], (t) => chunks.push(t), noSignal)
    expect(chunks.join('')).toBe('looking')
    expect(res.calls).toEqual([{ id: 't1', name: 'get_resource', args: { key: 'pods', name: 'api-0' } }])
  })

  it('propagates in-stream error events', async () => {
    const port = await serve(() => [JSON.stringify({ type: 'error', error: { message: 'overloaded' } })])
    const cfg: ProviderSettings = { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'm', apiKey: 'k' }
    await expect(chat(cfg, 's', [{ role: 'user', text: 'x' }], [], () => {}, noSignal)).rejects.toThrow('overloaded')
  })
})
