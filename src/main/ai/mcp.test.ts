import { afterEach, describe, expect, it } from 'vitest'
import { startMcpServer, type McpEndpoint } from './mcp'

let ep: McpEndpoint | undefined

afterEach(() => {
  ep?.close()
  ep = undefined
})

const calls: Array<{ name: string; args: Record<string, unknown> }> = []

async function start(): Promise<McpEndpoint> {
  ep = await startMcpServer(
    {
      runCall: async (c) => {
        calls.push({ name: c.name, args: c.args })
        return c.name === 'boom' ? 'Error: nope' : `ran ${c.name}`
      }
    },
    '9.9.9'
  )
  return ep
}

async function rpc(e: McpEndpoint, body: object, token?: string): Promise<{ status: number; json?: unknown }> {
  const res = await fetch(e.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? e.token}` },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}

describe('mcp server', () => {
  it('rejects a missing or wrong token', async () => {
    const e = await start()
    const bad = await rpc(e, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')
    expect(bad.status).toBe(401)
    const none = await fetch(e.url, { method: 'POST', body: '{}' })
    expect(none.status).toBe(401)
  })

  it('answers initialize and tools/list', async () => {
    const e = await start()
    const init = await rpc(e, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const initResult = (init.json as { result: { serverInfo: { name: string } } }).result
    expect(initResult.serverInfo.name).toBe('panope')
    const list = await rpc(e, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (list.json as { result: { tools: Array<{ name: string; inputSchema: object }> } }).result.tools
    expect(tools.length).toBeGreaterThan(10)
    expect(tools.map((t) => t.name)).toContain('scale_resource')
    expect(tools[0].inputSchema).toBeDefined()
  })

  it('routes tools/call through the bridge and flags Error results', async () => {
    const e = await start()
    const ok = await rpc(e, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_resources', arguments: { key: 'pods' } }
    })
    const okResult = (ok.json as { result: { content: Array<{ text: string }>; isError: boolean } }).result
    expect(okResult.content[0].text).toBe('ran list_resources')
    expect(okResult.isError).toBe(false)
    expect(calls.at(-1)).toEqual({ name: 'list_resources', args: { key: 'pods' } })

    const err = await rpc(e, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } })
    expect((err.json as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  it('accepts notifications without a response body and 405s non-POST', async () => {
    const e = await start()
    const note = await rpc(e, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    const get = await fetch(e.url, { headers: { authorization: `Bearer ${e.token}` } })
    expect(get.status).toBe(405)
  })
})
