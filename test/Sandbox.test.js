/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const EventEmitter = require('node:events')
const WebSocket = require('ws')
const Sandbox = require('../src/Sandbox')
const {
  SandboxClientError,
  SandboxCommandNotFoundError,
  SandboxInitializationError,
  SandboxNotFoundError,
  SandboxPortNotProvisionedError,
  SandboxInvalidPortError,
  SandboxTimeoutError,
  SandboxUnauthorizedError,
  SandboxWebSocketError
} = require('../src/errors')

jest.mock('ws')

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventEmitter {
  constructor (url) {
    super()
    this.url = url
    this.readyState = 0
    this.sent = []
  }

  send (data) { this.sent.push(data) }

  close () {
    this.readyState = 3
    this.emit('close', 1000, 'closed')
  }

  closeWith (code, reason = 'closed') {
    this.readyState = 3
    this.emit('close', code, reason)
  }

  open () {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  message (payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.emit('message', Buffer.from(data))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTIONS = {
  id: 'sb-test',
  endpoint: 'wss://runtime.example.net/ws/v1/namespaces/ns/sandbox/sb-test/exec',
  status: 'ready',
  namespace: 'ns',
  apiHost: 'https://runtime.example.net',
  apiKey: 'uuid:key',
  token: 'tok-abc',
  maxLifetime: 3600,
  cluster: 'cluster-a',
  region: 'va6'
}

let sockets

function setupWebSocket () {
  sockets = []
  WebSocket.OPEN = 1
  WebSocket.mockImplementation((url) => {
    const socket = new FakeWebSocket(url)
    sockets.push(socket)
    return socket
  })
}

async function buildConnectedSandbox (opts = {}) {
  const sandbox = new Sandbox({ ...BASE_OPTIONS, ...opts })
  const connectPromise = sandbox.connect()
  sockets[0].open()
  expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'auth', token: BASE_OPTIONS.token })
  sockets[0].message({ type: 'auth.ok', sandboxId: BASE_OPTIONS.id })
  await connectPromise
  return sandbox
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sandbox', () => {
  beforeEach(() => {
    setupWebSocket()
    jest.useRealTimers()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    delete process.env.__OW_API_HOST
    delete process.env.__OW_NAMESPACE
    delete process.env.__OW_API_KEY
  })

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  describe('resolveCredentials', () => {
    test('reads from env vars when no overrides provided', () => {
      process.env.__OW_API_HOST = 'https://host.example.net'
      process.env.__OW_NAMESPACE = 'my-ns'
      process.env.__OW_API_KEY = 'k:secret'

      const creds = Sandbox.resolveCredentials({})
      expect(creds.apiHost).toBe('https://host.example.net')
      expect(creds.namespace).toBe('my-ns')
      expect(creds.apiKey).toBe('k:secret')
    })

    test('explicit options override env vars', () => {
      process.env.__OW_API_HOST = 'https://env-host.example.net'
      process.env.__OW_NAMESPACE = 'env-ns'
      process.env.__OW_API_KEY = 'env-key'

      const creds = Sandbox.resolveCredentials({
        apiHost: 'https://explicit.example.net',
        namespace: 'explicit-ns',
        auth: 'explicit-key'
      })
      expect(creds.apiHost).toBe('https://explicit.example.net')
      expect(creds.namespace).toBe('explicit-ns')
      expect(creds.apiKey).toBe('explicit-key')
    })

    test('prepends https:// when scheme is missing', () => {
      const creds = Sandbox.resolveCredentials({
        apiHost: 'host.example.net',
        namespace: 'ns',
        auth: 'key'
      })
      expect(creds.apiHost).toBe('https://host.example.net')
    })

    test('throws SandboxInitializationError for missing credentials', () => {
      expect(() => Sandbox.resolveCredentials({})).toThrow(SandboxInitializationError)
    })
  })

  describe('normalizeSize', () => {
    test('defaults to MEDIUM', () => {
      expect(Sandbox.normalizeSize(undefined)).toBe('MEDIUM')
    })

    test('accepts valid size name', () => {
      expect(Sandbox.normalizeSize('LARGE')).toBe('LARGE')
    })

    test('maps a spec object to a size name', () => {
      expect(Sandbox.normalizeSize({ cpu: '500m', memory: '512Mi', gpu: 0 })).toBe('SMALL')
    })

    test('throws SandboxClientError for unknown size', () => {
      expect(() => Sandbox.normalizeSize('HUGE')).toThrow(SandboxClientError)
    })
  })

  describe('sizes', () => {
    test('exposes SANDBOX_SIZES as a static getter', () => {
      expect(Sandbox.sizes).toHaveProperty('SMALL')
      expect(Sandbox.sizes).toHaveProperty('MEDIUM')
      expect(Sandbox.sizes).toHaveProperty('LARGE')
      expect(Sandbox.sizes).toHaveProperty('XLARGE')
    })
  })

  // -------------------------------------------------------------------------
  // Static factories
  // -------------------------------------------------------------------------

  describe('Sandbox.create()', () => {
    test('creates a sandbox and returns a connected instance', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-new',
          wsEndpoint: 'wss://runtime.example.net/ws/v1/namespaces/ns/sandbox/sb-new/exec',
          status: 'ready',
          token: 'tok-new',
          maxLifetime: 3600,
          previewUrls: {
            3000: 'https://sb-new-3000.preview.example.net'
          }
        })
      })
      global.fetch = mockFetch

      const createPromise = Sandbox.create({
        name: 'my-sandbox',
        apiHost: 'https://runtime.example.net',
        namespace: 'ns',
        auth: 'uuid:key'
      })

      // flush fetch + json() microtasks so the WebSocket is created before we open it
      await new Promise(resolve => setImmediate(resolve))
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: 'sb-new' })

      const sandbox = await createPromise

      expect(sandbox.id).toBe('sb-new')
      expect(sandbox.status).toBe('ready')
      expect(sandbox.previewUrls).toEqual({
        3000: 'https://sb-new-3000.preview.example.net'
      })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://runtime.example.net/api/v1/namespaces/ns/sandbox',
        expect.objectContaining({ method: 'POST' })
      )
    })

    test('forwards policy in the request body', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-pol',
          wsEndpoint: 'wss://runtime.example.net/ws/v1/namespaces/ns/sandbox/sb-pol/exec',
          status: 'ready',
          token: 'tok-pol',
          maxLifetime: 3600
        })
      })
      global.fetch = mockFetch

      const policy = { network: { egress: [{ host: 'api.github.com', port: 443 }] } }
      const createPromise = Sandbox.create({
        name: 'policy-sandbox',
        apiHost: 'https://runtime.example.net',
        namespace: 'ns',
        auth: 'uuid:key',
        policy
      })

      await new Promise(resolve => setImmediate(resolve))
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: 'sb-pol' })
      await createPromise

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.policy).toEqual(policy)
    })

    test('forwards ports and populates previewUrls from the response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-ports',
          wsEndpoint: 'wss://runtime.example.net/ws/v1/namespaces/ns/sandbox/sb-ports/exec',
          status: 'ready',
          token: 'tok-ports',
          maxLifetime: 3600,
          previewUrls: {
            3000: 'https://sb-ports-3000.preview.example.net',
            8080: 'https://sb-ports-8080.preview.example.net'
          }
        })
      })
      global.fetch = mockFetch

      const createPromise = Sandbox.create({
        name: 'ports-sandbox',
        apiHost: 'https://runtime.example.net',
        namespace: 'ns',
        auth: 'uuid:key',
        ports: [3000, 8080]
      })

      await new Promise(resolve => setImmediate(resolve))
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: 'sb-ports' })
      const sandbox = await createPromise

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.ports).toEqual([3000, 8080])
      expect(sandbox.getUrl(3000)).toBe('https://sb-ports-3000.preview.example.net')
      expect(sandbox.getUrl(8080)).toBe('https://sb-ports-8080.preview.example.net')
    })

    test('reads credentials from env vars', async () => {
      process.env.__OW_API_HOST = 'https://runtime.example.net'
      process.env.__OW_NAMESPACE = 'ns'
      process.env.__OW_API_KEY = 'uuid:key'

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-env',
          wsEndpoint: 'wss://runtime.example.net/ws/v1/namespaces/ns/sandbox/sb-env/exec',
          status: 'ready',
          token: 'tok-env',
          maxLifetime: 3600
        })
      })
      global.fetch = mockFetch

      const createPromise = Sandbox.create({ name: 'env-sandbox' })
      await new Promise(resolve => setImmediate(resolve))
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: 'sb-env' })
      const sandbox = await createPromise

      expect(sandbox.id).toBe('sb-env')
    })

    test('throws SandboxInitializationError when credentials are missing', async () => {
      await expect(Sandbox.create({ name: 'no-creds' })).rejects.toThrow(SandboxInitializationError)
    })

    test('falls back to buildWebSocketEndpoint when wsEndpoint absent', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-noep',
          status: 'ready',
          token: 'tok-noep',
          maxLifetime: 3600
        })
      })
      global.fetch = mockFetch

      const createPromise = Sandbox.create({
        name: 'no-endpoint',
        apiHost: 'https://runtime.example.net',
        namespace: 'ns',
        auth: 'uuid:key'
      })

      await new Promise(resolve => setImmediate(resolve))
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: 'sb-noep' })
      const sandbox = await createPromise

      expect(sockets[0].url).toContain('wss://')
      expect(sockets[0].url).toContain('sb-noep')
    })
  })

  describe('Sandbox.get()', () => {
    test('returns a sandbox with status from the API', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sandboxId: 'sb-get',
          status: 'running',
          cluster: 'cluster-b',
          region: 'va6'
        })
      })

      const sandbox = await Sandbox.get('sb-get', {
        apiHost: 'https://runtime.example.net',
        namespace: 'ns',
        auth: 'uuid:key'
      })

      expect(sandbox.id).toBe('sb-get')
      expect(sandbox.status).toBe('running')
      expect(sandbox.cluster).toBe('cluster-b')
    })

    test('throws SandboxNotFoundError on 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('not found')
      })

      await expect(
        Sandbox.get('missing', { apiHost: 'https://runtime.example.net', namespace: 'ns', auth: 'key' })
      ).rejects.toThrow(SandboxNotFoundError)
    })

    test('throws SandboxUnauthorizedError on 401', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized')
      })

      await expect(
        Sandbox.get('sb-x', { apiHost: 'https://runtime.example.net', namespace: 'ns', auth: 'bad' })
      ).rejects.toThrow(SandboxUnauthorizedError)
    })
  })

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    test('opens WebSocket, sends auth frame, and resolves on auth.ok', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      const p = sandbox.connect()
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: BASE_OPTIONS.id })
      await p
      expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'auth', token: BASE_OPTIONS.token })
    })

    test('reuses an existing open socket', async () => {
      const sandbox = await buildConnectedSandbox()
      await sandbox.connect()
      expect(sockets).toHaveLength(1)
    })

    test('returns the same in-flight promise when called again before auth completes', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      const p1 = sandbox.connect()
      const p2 = sandbox.connect()
      expect(p1).toBe(p2)
      sockets[0].open()
      sockets[0].message({ type: 'auth.ok', sandboxId: BASE_OPTIONS.id })
      await Promise.all([p1, p2])
      expect(sockets).toHaveLength(1)
    })

    test('rejects on auth close code 4001 with SandboxUnauthorizedError', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      const p = sandbox.connect()
      sockets[0].open()
      sockets[0].closeWith(4001)
      await expect(p).rejects.toThrow(SandboxUnauthorizedError)
    })

    test('rejects on unexpected socket close', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      const p = sandbox.connect()
      sockets[0].open()
      sockets[0].closeWith(1006)
      await expect(p).rejects.toThrow(SandboxWebSocketError)
    })

    test('rejects with SandboxWebSocketError on socket error event during connect', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      const p = sandbox.connect()
      sockets[0].emit('error', new Error('ECONNREFUSED'))
      await expect(p).rejects.toThrow(SandboxWebSocketError)
      await expect(p).rejects.toThrow('ECONNREFUSED')
    })
  })

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------

  describe('exec()', () => {
    test('sends exec.run and resolves with stdout/stderr/exitCode', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('echo hello')
      const frame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'exec.output', execId: frame.execId, stream: 'stdout', data: 'hello\n' })
      sockets[0].message({ type: 'exec.exit', execId: frame.execId, exitCode: 0 })

      const result = await resultPromise
      expect(result.stdout).toBe('hello\n')
      expect(result.exitCode).toBe(0)
    })

    test('accumulates stderr separately', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('cmd')
      const frame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'exec.output', execId: frame.execId, stream: 'stderr', data: 'err\n' })
      sockets[0].message({ type: 'exec.exit', execId: frame.execId, exitCode: 1 })

      const result = await resultPromise
      expect(result.stderr).toBe('err\n')
      expect(result.exitCode).toBe(1)
    })

    test('sends stdin and closeStdin when options.stdin is provided', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('cat', { stdin: 'hello\n' })
      const execFrame = JSON.parse(sockets[0].sent[1])
      const stdinFrame = JSON.parse(sockets[0].sent[2])
      const endFrame = JSON.parse(sockets[0].sent[3])

      expect(stdinFrame.type).toBe('exec.input')
      expect(stdinFrame.data).toBe('hello\n')
      expect(endFrame.type).toBe('exec.endInput')

      sockets[0].message({ type: 'exec.exit', execId: execFrame.execId, exitCode: 0 })
      await resultPromise
    })

    test('calls onOutput callback for each output chunk', async () => {
      const sandbox = await buildConnectedSandbox()
      const chunks = []

      const resultPromise = sandbox.exec('cmd', { onOutput: (data, stream) => chunks.push({ data, stream }) })
      const frame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'exec.output', execId: frame.execId, stream: 'stdout', data: 'a' })
      sockets[0].message({ type: 'exec.output', execId: frame.execId, stream: 'stderr', data: 'b' })
      sockets[0].message({ type: 'exec.exit', execId: frame.execId, exitCode: 0 })

      await resultPromise
      expect(chunks).toEqual([{ data: 'a', stream: 'stdout' }, { data: 'b', stream: 'stderr' }])
    })

    test('rejects with SandboxTimeoutError when timeout elapses', async () => {
      jest.useFakeTimers()
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('sleep 100', { timeout: 1000 })
      jest.advanceTimersByTime(1001)

      await expect(resultPromise).rejects.toThrow(SandboxTimeoutError)
    })

    test('returns promise with execId property', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('echo hi')
      expect(typeof resultPromise.execId).toBe('string')
      expect(resultPromise.execId).toMatch(/^exec-/)

      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'exec.exit', execId: frame.execId, exitCode: 0 })
      await resultPromise
    })

    test('rejects with SandboxClientError on exec error frame', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('bad-cmd')
      const frame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'error', execId: frame.execId, message: 'command not found' })

      await expect(resultPromise).rejects.toThrow(SandboxClientError)
    })

    test('rejects when socket is not open', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      await expect(sandbox.exec('cmd')).rejects.toThrow(SandboxWebSocketError)
    })

    test('rejects exec after socket has closed (ws.ensureOpen path)', async () => {
      const sandbox = await buildConnectedSandbox()
      sockets[0].closeWith(1006)
      await expect(sandbox.exec('cmd')).rejects.toThrow(SandboxWebSocketError)
    })

    test('rejects with SandboxWebSocketError when socket.send throws during exec', async () => {
      const sandbox = await buildConnectedSandbox()
      sockets[0].send = () => { throw new Error('broken pipe') }
      await expect(sandbox.exec('cmd')).rejects.toThrow(SandboxWebSocketError)
    })
  })

  // -------------------------------------------------------------------------
  // kill / writeStdin / closeStdin
  // -------------------------------------------------------------------------

  describe('kill()', () => {
    test('sends exec.kill frame', async () => {
      const sandbox = await buildConnectedSandbox()
      sandbox.kill('exec-abc', 'SIGKILL')

      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('exec.kill')
      expect(frame.execId).toBe('exec-abc')
      expect(frame.signal).toBe('SIGKILL')
    })
  })

  describe('writeStdin()', () => {
    test('sends exec.input frame with string data', async () => {
      const sandbox = await buildConnectedSandbox()
      sandbox.writeStdin('exec-abc', 'hello\n')

      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('exec.input')
      expect(frame.data).toBe('hello\n')
      expect(frame.encoding).toBeUndefined()
    })

    test('base64-encodes Buffer data', async () => {
      const sandbox = await buildConnectedSandbox()
      sandbox.writeStdin('exec-abc', Buffer.from('binary'))

      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.encoding).toBe('base64')
      expect(Buffer.from(frame.data, 'base64').toString()).toBe('binary')
    })
  })

  describe('closeStdin()', () => {
    test('sends exec.endInput frame', async () => {
      const sandbox = await buildConnectedSandbox()
      sandbox.closeStdin('exec-abc')

      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('exec.endInput')
      expect(frame.execId).toBe('exec-abc')
    })
  })

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  describe('readFile()', () => {
    test('sends file.read and resolves with content', async () => {
      const sandbox = await buildConnectedSandbox()

      const filePromise = sandbox.readFile('/app/hello.js')
      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('file.read')
      expect(frame.path).toBe('/app/hello.js')

      const encoded = Buffer.from('console.log("hi")').toString('base64')
      sockets[0].message({ type: 'file.content', execId: frame.execId, content: encoded, encoding: 'base64' })

      const content = await filePromise
      expect(content).toBe('console.log("hi")')
    })

    test('resolves with raw string when no encoding', async () => {
      const sandbox = await buildConnectedSandbox()

      const filePromise = sandbox.readFile('/text.txt')
      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'file.content', execId: frame.execId, content: 'plain text' })

      expect(await filePromise).toBe('plain text')
    })

    test('rejects on error frame', async () => {
      const sandbox = await buildConnectedSandbox()

      const filePromise = sandbox.readFile('/missing')
      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'error', execId: frame.execId, message: 'no such file' })

      await expect(filePromise).rejects.toThrow(SandboxClientError)
    })
  })

  describe('writeFile()', () => {
    test('sends file.write with base64 content and resolves with write result', async () => {
      const sandbox = await buildConnectedSandbox()

      const writePromise = sandbox.writeFile('/app/script.js', 'const x = 1')
      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('file.write')
      expect(frame.encoding).toBe('base64')

      sockets[0].message({ type: 'file.writeResult', execId: frame.execId, path: frame.path, size: 11, ok: true })

      const result = await writePromise
      expect(result.ok).toBe(true)
      expect(result.size).toBe(11)
    })

    test('rejects on failed write result', async () => {
      const sandbox = await buildConnectedSandbox()

      const writePromise = sandbox.writeFile('/readonly', 'data')
      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'file.writeResult', execId: frame.execId, path: frame.path, ok: false })

      await expect(writePromise).rejects.toThrow(SandboxClientError)
    })
  })

  describe('listFiles()', () => {
    test('sends file.list and resolves with entries', async () => {
      const sandbox = await buildConnectedSandbox()

      const listPromise = sandbox.listFiles('.')
      const frame = JSON.parse(sockets[0].sent[1])
      expect(frame.type).toBe('file.list')

      const entries = [
        { name: 'hello.js', type: 'file', size: 42 },
        { name: 'src', type: 'directory' }
      ]
      sockets[0].message({ type: 'file.entries', execId: frame.execId, entries })

      expect(await listPromise).toEqual(entries)
    })

    test('resolves with empty array when entries is absent', async () => {
      const sandbox = await buildConnectedSandbox()

      const listPromise = sandbox.listFiles('.')
      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'file.entries', execId: frame.execId })

      expect(await listPromise).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // getUrl
  // -------------------------------------------------------------------------

  describe('getUrl()', () => {
    test('resolves preview URL from previewUrls map', () => {
      const sandbox = new Sandbox({
        ...BASE_OPTIONS,
        previewUrls: new Map([[3000, 'https://sb-test-3000.preview.example.net']])
      })

      const url = sandbox.getUrl(3000)
      expect(url).toBe('https://sb-test-3000.preview.example.net')
    })

    test('throws SandboxPortNotProvisionedError when port was not provisioned', () => {
      const sandbox = new Sandbox({
        ...BASE_OPTIONS,
        previewUrls: new Map([[3000, 'https://sb-test-3000.preview.example.net']])
      })
      expect(() => sandbox.getUrl(9999)).toThrow(SandboxPortNotProvisionedError)
    })

    test('throws SandboxInvalidPortError for out-of-range port', () => {
      const sandbox = new Sandbox({
        ...BASE_OPTIONS,
        previewUrls: new Map([[3000, 'https://sb-test-3000.preview.example.net']])
      })
      expect(() => sandbox.getUrl(0)).toThrow(SandboxInvalidPortError)
      expect(() => sandbox.getUrl(65536)).toThrow(SandboxInvalidPortError)
    })

    test('throws SandboxInvalidPortError for non-integer port', () => {
      const sandbox = new Sandbox({
        ...BASE_OPTIONS,
        previewUrls: new Map([[3000, 'https://sb-test-3000.preview.example.net']])
      })
      expect(() => sandbox.getUrl('abc')).toThrow(SandboxInvalidPortError)
      expect(() => sandbox.getUrl(3000.5)).toThrow(SandboxInvalidPortError)
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy()', () => {
    test('calls DELETE and closes the socket', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'destroyed' })
      })
      global.fetch = mockFetch

      const sandbox = await buildConnectedSandbox()
      const result = await sandbox.destroy()

      expect(result.status).toBe('destroyed')
      expect(sandbox.status).toBe('destroyed')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sandbox/sb-test'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })

    test('throws SandboxUnauthorizedError on 403', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('forbidden')
      })

      const sandbox = await buildConnectedSandbox()
      await expect(sandbox.destroy()).rejects.toThrow(SandboxUnauthorizedError)
    })
  })

  // -------------------------------------------------------------------------
  // Detached exec
  // -------------------------------------------------------------------------

  describe('exec() with detached: true', () => {
    test('sends exec.run with detached:true and resolves with command object on exec.detached', async () => {
      const sandbox = await buildConnectedSandbox()
      const chunks = []

      const commandPromise = sandbox.exec('npm run dev', {
        detached: true,
        onOutput: (data, stream) => chunks.push({ data, stream })
      })
      const runFrame = JSON.parse(sockets[0].sent[1])
      expect(runFrame.type).toBe('exec.run')
      expect(runFrame.detached).toBe(true)

      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 9999, startedAt: 1234567890 })

      const command = await commandPromise
      expect(command.execId).toBe(runFrame.execId)
      expect(command.pid).toBe(9999)
      expect(command.startedAt).toBe(1234567890)
      expect(command.detached).toBe(true)
      expect(typeof command.wait).toBe('function')
      expect(typeof command.kill).toBe('function')
      expect(typeof command.writeStdin).toBe('function')
      expect(typeof command.closeStdin).toBe('function')
    })

    test('wait() resolves with exitCode when exec.exit arrives', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.exec('sleep 100', { detached: true })
      const runFrame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 1234, startedAt: 1000000 })
      const command = await commandPromise

      const waitPromise = command.wait()
      sockets[0].message({ type: 'exec.exit', execId: runFrame.execId, exitCode: 0 })

      const result = await waitPromise
      expect(result.exitCode).toBe(0)
    })

    test('output frames after exec.detached are delivered to onOutput', async () => {
      const sandbox = await buildConnectedSandbox()
      const chunks = []

      const commandPromise = sandbox.exec('npm run dev', {
        detached: true,
        onOutput: (data, stream) => chunks.push({ data, stream })
      })
      const runFrame = JSON.parse(sockets[0].sent[1])

      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 9000, startedAt: 1 })
      await commandPromise

      sockets[0].message({ type: 'exec.output', execId: runFrame.execId, stream: 'stdout', data: 'compiled\n' })
      expect(chunks).toEqual([{ data: 'compiled\n', stream: 'stdout' }])
    })

    test('rejects with SandboxClientError when timeout is combined with detached', async () => {
      const sandbox = await buildConnectedSandbox()
      await expect(
        sandbox.exec('npm run dev', { detached: true, timeout: 5000 })
      ).rejects.toThrow(SandboxClientError)
    })

    test('error frame on detached exec rejects wait()', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.exec('bad-cmd', { detached: true })
      const runFrame = JSON.parse(sockets[0].sent[1])

      // Resolve outer promise first (process started)
      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 1, startedAt: 1 })
      const command = await commandPromise

      const waitPromise = command.wait()
      // Then an error arrives (e.g. process crashed with error frame)
      sockets[0].message({ type: 'error', execId: runFrame.execId, message: 'process crashed' })

      await expect(waitPromise).rejects.toThrow(SandboxClientError)
    })
  })

  // -------------------------------------------------------------------------
  // getCommand
  // -------------------------------------------------------------------------

  describe('getCommand()', () => {
    test('sends exec.get and resolves with command object on exec.info', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.getCommand('exec-d1e2f3a4', { onOutput: () => {} })
      const getFrame = JSON.parse(sockets[0].sent[1])
      expect(getFrame.type).toBe('exec.get')
      expect(getFrame.execId).toBe('exec-d1e2f3a4')

      sockets[0].message({
        type: 'exec.info',
        execId: 'exec-d1e2f3a4',
        command: 'npm run dev',
        pid: 5678,
        startedAt: 1711036812,
        detached: true
      })

      const command = await commandPromise
      expect(command.execId).toBe('exec-d1e2f3a4')
      expect(command.command).toBe('npm run dev')
      expect(command.pid).toBe(5678)
      expect(command.startedAt).toBe(1711036812)
      expect(command.detached).toBe(true)
      expect(typeof command.wait).toBe('function')
    })

    test('wait() resolves when exec.exit arrives after getCommand()', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.getCommand('exec-reattach')
      JSON.parse(sockets[0].sent[1]) // exec.get frame
      sockets[0].message({
        type: 'exec.info',
        execId: 'exec-reattach',
        command: 'sleep 60',
        pid: 1111,
        startedAt: 100,
        detached: true
      })

      const command = await commandPromise
      const waitPromise = command.wait()

      sockets[0].message({ type: 'exec.exit', execId: 'exec-reattach', exitCode: 143 })
      const result = await waitPromise
      expect(result.exitCode).toBe(143)
    })

    test('throws SandboxCommandNotFoundError when error NOT_FOUND is returned', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.getCommand('exec-gone')
      JSON.parse(sockets[0].sent[1])
      sockets[0].message({
        type: 'error',
        execId: 'exec-gone',
        code: 'NOT_FOUND',
        message: 'no running process for execId'
      })

      await expect(commandPromise).rejects.toThrow(SandboxCommandNotFoundError)
    })

    test('rejects when socket is not open', async () => {
      const sandbox = new Sandbox(BASE_OPTIONS)
      await expect(sandbox.getCommand('exec-x')).rejects.toThrow(SandboxWebSocketError)
    })

    test('reuses existing wait promise when exec is already running in same session', async () => {
      const sandbox = await buildConnectedSandbox()

      // Start a detached exec so it lands in pendingExecs
      const commandPromise = sandbox.exec('npm run dev', { detached: true })
      const runFrame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 100, startedAt: 1 })
      const command = await commandPromise

      // Reattach via getCommand for the same execId
      const getPromise = sandbox.getCommand(runFrame.execId)
      sockets[0].message({
        type: 'exec.info',
        execId: runFrame.execId,
        command: 'npm run dev',
        pid: 100,
        startedAt: 1,
        detached: true
      })
      const reattached = await getPromise

      // Both wait() calls share the same underlying promise
      const w1 = command.wait()
      const w2 = reattached.wait()
      expect(w1).toBe(w2)

      sockets[0].message({ type: 'exec.exit', execId: runFrame.execId, exitCode: 0 })
      const [r1, r2] = await Promise.all([w1, w2])
      expect(r1.exitCode).toBe(0)
      expect(r2.exitCode).toBe(0)
    })

    test('delivers subsequent output to both original and reattached onOutput callbacks', async () => {
      const sandbox = await buildConnectedSandbox()
      const original = []
      const reattached = []

      const commandPromise = sandbox.exec('npm run dev', {
        detached: true,
        onOutput: (data, stream) => original.push({ data, stream })
      })
      const runFrame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'exec.detached', execId: runFrame.execId, pid: 1, startedAt: 1 })
      await commandPromise

      const getPromise = sandbox.getCommand(runFrame.execId, {
        onOutput: (data, stream) => reattached.push({ data, stream })
      })
      sockets[0].message({
        type: 'exec.info',
        execId: runFrame.execId,
        command: 'npm run dev',
        pid: 1,
        startedAt: 1,
        detached: true
      })
      await getPromise

      sockets[0].message({ type: 'exec.output', execId: runFrame.execId, stream: 'stdout', data: 'hello\n' })
      expect(original).toEqual([{ data: 'hello\n', stream: 'stdout' }])
      expect(reattached).toEqual([{ data: 'hello\n', stream: 'stdout' }])
    })

    test('command object writeStdin / closeStdin / kill delegate to sandbox', async () => {
      const sandbox = await buildConnectedSandbox()

      const getPromise = sandbox.getCommand('exec-xyz')
      sockets[0].message({
        type: 'exec.info',
        execId: 'exec-xyz',
        command: 'tail -f /log',
        pid: 42,
        startedAt: 1000,
        detached: true
      })
      const command = await getPromise

      command.writeStdin('hello\n')
      const inputFrame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])
      expect(inputFrame.type).toBe('exec.input')
      expect(inputFrame.execId).toBe('exec-xyz')
      expect(inputFrame.data).toBe('hello\n')

      command.closeStdin()
      const endFrame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])
      expect(endFrame.type).toBe('exec.endInput')
      expect(endFrame.execId).toBe('exec-xyz')

      command.kill('SIGINT')
      const killFrame = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1])
      expect(killFrame.type).toBe('exec.kill')
      expect(killFrame.execId).toBe('exec-xyz')
      expect(killFrame.signal).toBe('SIGINT')
    })
  })

  // -------------------------------------------------------------------------
  // Socket close drains pending operations
  // -------------------------------------------------------------------------

  describe('WebSocket close', () => {
    test('rejects all pending execs when socket closes unexpectedly', async () => {
      const sandbox = await buildConnectedSandbox()

      const resultPromise = sandbox.exec('sleep 60')
      sockets[0].closeWith(1006)

      await expect(resultPromise).rejects.toThrow(SandboxWebSocketError)
    })

    test('rejects all pending file ops when socket closes', async () => {
      const sandbox = await buildConnectedSandbox()

      const filePromise = sandbox.readFile('/heavy-file')
      sockets[0].closeWith(1006)

      await expect(filePromise).rejects.toThrow(SandboxWebSocketError)
    })

    test('rejects pending getCommand when socket closes before exec.info arrives', async () => {
      const sandbox = await buildConnectedSandbox()

      const commandPromise = sandbox.getCommand('exec-running')
      sockets[0].closeWith(1006)

      await expect(commandPromise).rejects.toThrow(SandboxWebSocketError)
    })

    test('silently ignores incoming messages with invalid JSON', async () => {
      const sandbox = await buildConnectedSandbox()

      sockets[0].emit('message', Buffer.from('not-valid-json!!!'))

      const resultPromise = sandbox.exec('echo hi')
      const frame = JSON.parse(sockets[0].sent[1])
      sockets[0].message({ type: 'exec.exit', execId: frame.execId, exitCode: 0 })
      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })
    })
  })
})
