import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ALL_TOOLS } from './tools'
import type { AiToolCallReq } from './provider'

/**
 * Minimal MCP server (JSON-RPC 2.0 over loopback HTTP) exposing Panope's
 * tools to a locally spawned Claude Code process. Hand-rolled because the
 * protocol subset we need is four methods, and the reference SDK is ESM-only.
 *
 * Every tools/call funnels through the same runCall bridge the built-in
 * providers use, so read tools show chips and mutations stop at the same
 * confirmation card. The bearer token means nothing else on the machine can
 * drive cluster access through this port.
 */

export interface McpBridge {
  runCall(call: AiToolCallReq): Promise<string>
}

export interface McpEndpoint {
  url: string
  token: string
  close(): void
}

let seq = 0

export function startMcpServer(bridge: McpBridge, version: string): Promise<McpEndpoint> {
  const token = randomBytes(24).toString('hex')

  const rpc = async (msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<object | null> => {
    const { id, method, params } = msg
    // notifications carry no id and expect no response
    if (id === undefined || id === null) return null
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'panope', version }
          }
        }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))
          }
        }
      case 'tools/call': {
        const name = String(params?.name ?? '')
        const args = (params?.arguments ?? {}) as Record<string, unknown>
        const text = await bridge.runCall({ id: `mcp_${++seq}`, name, args })
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: text.startsWith('Error:') }
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } }
    }
  }

  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
          const out = await rpc(JSON.parse(body))
          if (out === null) {
            res.writeHead(202).end()
          } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
          }
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) }
            })
          )
        }
      })()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        close: () => server.close()
      })
    })
  })
}
