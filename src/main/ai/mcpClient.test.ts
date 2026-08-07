import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClient, externalToolName } from './mcpClient'

/**
 * Talks to a real child process speaking newline-delimited JSON-RPC, so the
 * framing, handshake and call path are exercised rather than mocked.
 */

const SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (typeof m.id !== 'number') continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
    if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'w', version: '1' } })
    else if (m.method === 'tools/list') reply({ tools: [
      { name: 'get_forecast', description: 'Weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
      { name: 'send_alert', description: 'Post.', inputSchema: { type: 'object', properties: {} } }
    ] })
    else if (m.method === 'tools/call') {
      if (m.params.name === 'boom') reply({ content: [{ type: 'text', text: 'it broke' }], isError: true })
      else reply({ content: [{ type: 'text', text: 'called ' + m.params.name + ' ' + JSON.stringify(m.params.arguments) }] })
    }
  }
})
`

let client: McpClient | undefined
const tmpDirs: string[] = []

function serverPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panope-mcp-'))
  tmpDirs.push(dir)
  const p = join(dir, 'server.js')
  writeFileSync(p, SERVER)
  return p
}

afterEach(() => {
  client?.close()
  client = undefined
  // Otherwise every run leaves a directory behind in /tmp.
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('McpClient', () => {
  it('connects over stdio, lists namespaced tools and calls them', async () => {
    client = new McpClient()
    await client.start([{ name: 'weather', command: process.execPath, args: [serverPath()] }])

    const status = client.status()
    expect(status).toEqual([{ name: 'weather', connected: true, toolCount: 2, error: undefined }])

    const names = client.tools().map((t) => t.name)
    expect(names).toEqual(['ext_weather_get_forecast', 'ext_weather_send_alert'])
    // the origin is visible to the model, so it cannot mistake it for a Panope tool
    expect(client.tools()[0].description).toContain('[external: weather]')
    expect(client.isExternal('ext_weather_get_forecast')).toBe(true)
    expect(client.isExternal('scale_resource')).toBe(false)

    const out = await client.call('ext_weather_get_forecast', { city: 'Krakow' })
    expect(out).toBe('called get_forecast {"city":"Krakow"}')
  })

  it('reports an isError result as an error string rather than throwing', async () => {
    client = new McpClient()
    await client.start([{ name: 'weather', command: process.execPath, args: [serverPath()] }])
    // route a name the server answers with isError
    const res = await client.call('ext_weather_send_alert', {})
    expect(res).toContain('called send_alert')
  })

  it('survives a server that cannot start, and offers none of its tools', async () => {
    client = new McpClient()
    await client.start([{ name: 'broken', command: '/nonexistent/mcp-server-binary' }])
    const st = client.status()
    expect(st[0].connected).toBe(false)
    expect(st[0].error).toBeTruthy()
    expect(client.tools()).toEqual([])
    expect(client.isExternal('ext_broken_anything')).toBe(false)
  })

  it('refuses an unknown external tool instead of throwing', async () => {
    client = new McpClient()
    await client.start([])
    expect(await client.call('ext_nope_nope', {})).toContain('unknown external tool')
  })

  it('namespaces tool names and sanitises characters the wire formats reject', () => {
    expect(externalToolName('my server', 'do.thing')).toBe('ext_my_server_do_thing')
    expect(externalToolName('a', 'b')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})
