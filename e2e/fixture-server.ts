/**
 * Local HTTP + WebSocket server that serves the fixture page and replays an
 * NDJSON capture as real, msgpack-encoded binary WebSocket frames -- driving
 * the extension's actual `web_accessible_resource.ts` WebSocket interceptor
 * exactly as the real game client would.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { encode } from '@msgpack/msgpack'
import { FIXTURE_PORT, PUBLIC_DIR, DEFAULT_FIXTURE } from './config.ts'

export interface FixtureServerOptions {
  /** Path to an NDJSON file, one decoded API event (JSON) per line. */
  fixturePath?: string
  port?: number
  /**
   * Delay between events in ms. 0 (default) replays as fast as the event
   * loop allows -- deterministic and fast for CI/scripted runs. Set higher
   * for human/AI-agent exploratory QA where the HUD should visibly update
   * hand by hand.
   */
  replayDelayMs?: number
}

export interface FixtureServerHandle {
  port: number
  origin: string
  /** Resolves once every event in the fixture has been sent to at least one connected client. */
  replayDone: Promise<void>
  close: () => Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const loadEvents = (fixturePath: string): unknown[] =>
  readFileSync(fixturePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts the fixture server. Every event in the fixture is replayed once per
 * connecting client (the harness opens exactly one fixture page per run).
 */
export const startFixtureServer = async (options: FixtureServerOptions = {}): Promise<FixtureServerHandle> => {
  const port = options.port ?? FIXTURE_PORT
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE
  const replayDelayMs = options.replayDelayMs ?? 0
  const events = loadEvents(fixturePath)

  let resolveReplayDone!: () => void
  const replayDone = new Promise<void>((resolve) => { resolveReplayDone = resolve })

  const publicDirResolved = resolve(PUBLIC_DIR)

  const httpServer: HttpServer = createServer((req, res) => {
    const rawUrl = req.url === '/' ? '/fixture.html' : req.url || '/fixture.html'
    // Strip any query string before touching the filesystem.
    const pathname = rawUrl.split('?')[0]!
    let decodedPathname: string
    try {
      decodedPathname = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }

    // `join` collapses `..` segments, so a request like `/../../package.json`
    // can otherwise resolve outside PUBLIC_DIR (local-only server, but this
    // is served over plain HTTP, so verify the resolved path actually stays
    // under PUBLIC_DIR before reading it -- don't just trust `join`).
    const resolvedPath = resolve(join(PUBLIC_DIR, decodedPathname))
    const staysInPublicDir =
      resolvedPath === publicDirResolved || resolvedPath.startsWith(publicDirResolved + sep)
    if (!staysInPublicDir) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    const ext = decodedPathname.includes('.') ? decodedPathname.slice(decodedPathname.lastIndexOf('.')) : '.html'
    try {
      const body = readFileSync(resolvedPath)
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/replay' })

  wss.on('connection', (socket: WebSocket) => {
    void (async () => {
      for (const event of events) {
        if (socket.readyState !== socket.OPEN) return
        socket.send(encode(event))
        if (replayDelayMs > 0) await sleep(replayDelayMs)
      }
      resolveReplayDone()
      // Give the last frame a moment to be processed before closing.
      await sleep(50)
      if (socket.readyState === socket.OPEN) socket.close()
    })()
  })

  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve))

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      wss.close(() => {
        httpServer.close((err) => (err ? reject(err) : resolve()))
      })
    })

  return { port, origin: `http://localhost:${port}`, replayDone, close }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = await startFixtureServer()
  console.log(`[fixture-server] listening on ${handle.origin} (Ctrl+C to stop)`)
}
