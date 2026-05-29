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

const crypto = require('node:crypto')
const {
  SandboxClientError,
  SandboxTimeoutError,
  SandboxWebSocketError,
  SandboxPortNotProvisionedError,
  SandboxInvalidPortError
} = require('./errors')
const {
  buildWebSocketEndpoint,
  resolveCredentials,
  normalizeSize,
  apiRequest
} = require('./utils')
const { SANDBOX_SIZES } = require('./constants')
const { SandboxSocket } = require('./ws')

/**
 * Connected compute sandbox session.
 *
 * Use `Sandbox.create()` or `Sandbox.get()`
 */
class Sandbox {
  /**
   * @param {object} options sandbox options
   * @private
   */
  constructor (options) {
    this.id = options.id
    this.endpoint = options.endpoint
    this.status = options.status
    this.cluster = options.cluster
    this.region = options.region
    this.maxLifetime = options.maxLifetime

    this.namespace = options.namespace
    this.apiHost = options.apiHost
    this.apiKey = options.apiKey
    this.token = options.token
    // previewUrls is a Map<number, string> of (port → URL) returned by the server.
    this.previewUrls = options.previewUrls || new Map()
    this.managementEndpoint = options.managementEndpoint || null
    this.ws = null
  }

  /**
   * Creates a new compute sandbox and opens its WebSocket session.
   *
   * Credentials are read from the environment automatically when running inside
   * a Runtime action (`__OW_API_HOST`, `__OW_NAMESPACE`, `__OW_API_KEY`).
   * Any value passed explicitly in `options` overrides the environment.
   *
   * Commands run inside the sandbox start in the `/workspace` directory by default.
   *
   * @param {object} [options] creation options
   * @param {string} [options.apiHost] Runtime API host (overrides `__OW_API_HOST`)
   * @param {string} [options.namespace] Runtime namespace (overrides `__OW_NAMESPACE`)
   * @param {string} [options.auth] Runtime API key (overrides `__OW_API_KEY`)
   * @param {string} [options.name] sandbox display name
   * @param {string} [options.type] sandbox type (default: `'cpu:default'`)
   * @param {string|object} [options.size] sandbox size tier (name or spec object)
   * @param {number} [options.maxLifetime] maximum lifetime in seconds
   * @param {number[]} [options.ports] TCP ports to expose via preview URLs (default: `[]`)
   * @param {object} [options.envs] environment variables to inject into the sandbox
   * @param {object} [options.policy] network policy (e.g. egress allowlist)
   * @returns {Promise<Sandbox>} connected sandbox instance
   */
  static async create (options = {}) {
    console.warn('[aio-lib-sandbox] alpha — APIs may change without notice')
    const creds = resolveCredentials(options)

    const body = {
      name: options.name,
      size: normalizeSize(options.size),
      type: options.type || 'cpu:default',
      maxLifetime: options.maxLifetime || 3600
    }

    if (options.cluster !== undefined) body.cluster = options.cluster
    if (options.region !== undefined) body.region = options.region
    if (options.envs !== undefined) body.envs = options.envs
    if (options.policy !== undefined) body.policy = options.policy
    if (options.ports !== undefined) body.ports = options.ports

    const url = `${creds.apiHost}/api/v1/namespaces/${creds.namespace}/sandbox`
    const payload = await apiRequest('POST', url, creds.apiKey, body)

    const sandboxId = payload.sandboxId
    const endpoint = payload.wsEndpoint || buildWebSocketEndpoint(creds.apiHost, creds.namespace, sandboxId)

    const sandbox = new Sandbox({
      id: sandboxId,
      endpoint,
      status: payload.status,
      cluster: payload.cluster,
      region: payload.region,
      maxLifetime: payload.maxLifetime,
      previewUrls: parsePreviewUrls(payload.previewUrls),
      managementEndpoint: payload.managementEndpoint || null,
      namespace: creds.namespace,
      apiHost: creds.apiHost,
      apiKey: creds.apiKey,
      token: payload.token
    })

    await sandbox.connect()
    return sandbox
  }

  /**
   * Fetches an existing sandbox.
   *
   * Credentials are read from the environment automatically.
   * Any value passed explicitly in `options` overrides the environment.
   *
   * @param {string} sandboxId the sandbox ID to look up
   * @param {object} [options] credential overrides
   * @param {string} [options.apiHost] Runtime API host
   * @param {string} [options.namespace] Runtime namespace
   * @param {string} [options.auth] Runtime API key
   * @returns {Promise<Sandbox>} sandbox instance with `status` populated (not WebSocket-connected)
   */
  static async get (sandboxId, options = {}) {
    console.warn('[aio-lib-sandbox] alpha — APIs may change without notice')
    const creds = resolveCredentials(options)
    const url = `${creds.apiHost}/api/v1/namespaces/${creds.namespace}/sandbox/${sandboxId}`
    const payload = await apiRequest('GET', url, creds.apiKey)

    return new Sandbox({
      id: payload.sandboxId || sandboxId,
      endpoint: null,
      status: payload.status,
      cluster: payload.cluster,
      region: payload.region,
      maxLifetime: payload.maxLifetime,
      previewUrls: parsePreviewUrls(payload.previewUrls),
      namespace: creds.namespace,
      apiHost: creds.apiHost,
      apiKey: creds.apiKey,
      token: null
    })
  }

  /**
   * Named sandbox size tiers.
   *
   * @type {object}
   */
  static get sizes () {
    return SANDBOX_SIZES
  }

  /**
   * Exposes `resolveCredentials` as a static helper (useful for testing).
   *
   * @param {object} overrides credential overrides
   * @returns {{ apiHost: string, namespace: string, apiKey: string }}
   */
  static resolveCredentials (overrides = {}) {
    return resolveCredentials(overrides)
  }

  /**
   * Exposes `normalizeSize` as a static helper (useful for testing).
   *
   * @param {string|object|undefined} size
   * @returns {string}
   */
  static normalizeSize (size) {
    return normalizeSize(size)
  }

  // ------------------------------------------------------------------
  // WebSocket connection
  // ------------------------------------------------------------------

  /**
   * Opens the sandbox WebSocket connection (called automatically by `create()`).
   *
   * @returns {Promise<void>}
   */
  connect () {
    if (!this.ws) {
      this.ws = new SandboxSocket({
        id: this.id,
        endpoint: this.endpoint,
        token: this.token
      })
    }
    return this.ws.connect()
  }

  // ------------------------------------------------------------------
  // Exec
  // ------------------------------------------------------------------

  /**
   * Executes a command inside the sandbox.
   *
   * Returns a Promise (with an `execId` property) that resolves to
   * `{ execId, stdout, stderr, exitCode }` when the command completes.
   *
   * @param {string} command command to run
   * @param {object} [options] execution options
   * @param {number} [options.timeout] timeout in milliseconds
   * @param {string|Buffer} [options.stdin] data to send to stdin at startup
   * @param {function} [options.onOutput] callback called with `(data, stream)` for each output chunk
   * @returns {Promise<{execId: string, stdout: string, stderr: string, exitCode: number}>}
   */
  exec (command, options = {}) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    const execId = `exec-${crypto.randomBytes(12).toString('hex')}`
    let timeoutHandle

    const execPromise = new Promise((resolve, reject) => {
      this.ws.pendingExecs.set(execId, {
        resolve,
        reject,
        stdout: '',
        stderr: '',
        onOutput: options.onOutput,
        timeout: undefined
      })

      if (options.timeout) {
        timeoutHandle = setTimeout(() => {
          try { this.kill(execId) } catch (_) {}
          this.ws.rejectExec(execId, new SandboxTimeoutError(
            `Command '${command}' exceeded timeout of ${options.timeout}ms`
          ))
        }, options.timeout)
        this.ws.pendingExecs.get(execId).timeout = timeoutHandle
      }
    })

    execPromise.execId = execId

    try {
      this.sendFrame({ type: 'exec.run', execId, command })
      if (options.stdin !== undefined) {
        this.writeStdin(execId, options.stdin)
        this.closeStdin(execId)
      }
    } catch (error) {
      this.ws.rejectExec(execId, new SandboxWebSocketError(
        `Could not send exec frame: ${error.message}`
      ))
    }

    return execPromise
  }

  /**
   * Sends a signal to a running command.
   *
   * @param {string} execId execution id
   * @param {string} [signal] signal to deliver (default: `'SIGTERM'`)
   */
  kill (execId, signal = 'SIGTERM') {
    this.ensureOpen()
    this.sendFrame({ type: 'exec.kill', execId, signal })
  }

  /**
   * Writes data to the stdin of a running command.
   * Fire-and-forget — there is no response on success.
   *
   * @param {string} execId execution id from `exec()`
   * @param {string|Buffer} data data to write
   */
  writeStdin (execId, data) {
    this.ensureOpen()
    const frame = { type: 'exec.input', execId }
    if (Buffer.isBuffer(data)) {
      frame.data = data.toString('base64')
      frame.encoding = 'base64'
    } else {
      frame.data = data
    }
    this.sendFrame(frame)
  }

  /**
   * Closes stdin for a running command, signalling EOF.
   * Fire-and-forget — there is no response on success.
   *
   * @param {string} execId execution id from `exec()`
   */
  closeStdin (execId) {
    this.ensureOpen()
    this.sendFrame({ type: 'exec.endInput', execId })
  }

  // ------------------------------------------------------------------
  // File operations
  // ------------------------------------------------------------------

  /**
   * Reads a file from the sandbox filesystem.
   *
   * @param {string} path path inside the sandbox
   * @returns {Promise<string>} file contents as a UTF-8 string
   */
  readFile (path) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    const execId = `file-${crypto.randomBytes(12).toString('hex')}`
    const opPromise = new Promise((resolve, reject) => {
      this.ws.pendingFileOps.set(execId, { resolve, reject })
    })

    try {
      this.sendFrame({ type: 'file.read', execId, path })
    } catch (error) {
      this.ws.rejectFileOp(execId, new SandboxWebSocketError(
        `Could not send file.read frame: ${error.message}`
      ))
    }

    return opPromise
  }

  /**
   * Writes a file to the sandbox filesystem. Parent directories are created automatically.
   *
   * @param {string} path path inside the sandbox
   * @param {string|Buffer} content file contents
   * @returns {Promise<{path: string, size: number, ok: boolean}>} write confirmation
   */
  writeFile (path, content) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    const execId = `file-${crypto.randomBytes(12).toString('hex')}`
    const encoded = Buffer.isBuffer(content)
      ? content.toString('base64')
      : Buffer.from(content).toString('base64')

    const opPromise = new Promise((resolve, reject) => {
      this.ws.pendingFileOps.set(execId, { resolve, reject })
    })

    try {
      this.sendFrame({ type: 'file.write', execId, path, content: encoded, encoding: 'base64' })
    } catch (error) {
      this.ws.rejectFileOp(execId, new SandboxWebSocketError(
        `Could not send file.write frame: ${error.message}`
      ))
    }

    return opPromise
  }

  /**
   * Lists the contents of a directory inside the sandbox.
   *
   * @param {string} path directory path inside the sandbox
   * @returns {Promise<Array<{name: string, type: string, size?: number}>>} directory entries
   */
  listFiles (path) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    const execId = `file-${crypto.randomBytes(12).toString('hex')}`
    const opPromise = new Promise((resolve, reject) => {
      this.ws.pendingFileOps.set(execId, { resolve, reject })
    })

    try {
      this.sendFrame({ type: 'file.list', execId, path })
    } catch (error) {
      this.ws.rejectFileOp(execId, new SandboxWebSocketError(
        `Could not send file.list frame: ${error.message}`
      ))
    }

    return opPromise
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Returns the public preview URL for a given port on this sandbox.
   *
   * This is a synchronous local lookup against the `previewUrls` map returned
   * by the server at create time. The URL is opaque — do not parse or reconstruct it.
   *
   * @param {number} port port number (1–65535)
   * @returns {string} public preview URL
   * @throws {SandboxInvalidPortError} when `port` is not an integer in the
   *   range 1–65535
   * @throws {SandboxPortNotProvisionedError} when `port` is valid but was not
   *   declared in `create({ ports })`
   */
  getUrl (port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxInvalidPortError(
        `Invalid port '${port}': must be an integer between 1 and 65535`
      )
    }

    const url = this.previewUrls.get(port)
    if (url === undefined) {
      throw new SandboxPortNotProvisionedError(
        `Port ${port} was not provisioned for sandbox '${this.id}'. ` +
        "Declare it in create({ ports: [...] }) to get a preview URL."
      )
    }

    return url
  }

  /**
   * Destroys the sandbox and closes its WebSocket connection.
   *
   * @returns {Promise<object>} destroy response payload
   */
  async destroy () {
    const base = this.managementEndpoint || this.apiHost
    const url = `${base}/api/v1/namespaces/${this.namespace}/sandbox/${this.id}`
    const payload = await apiRequest('DELETE', url, this.apiKey)

    this.status = payload.status || this.status
    this.ws?.close()
    return payload
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  ensureOpen () {
    if (!this.ws) {
      throw new SandboxWebSocketError(`Sandbox '${this.id}' is not connected`)
    }
    this.ws.ensureOpen()
  }

  sendFrame (frame) {
    this.ws.send(frame)
  }
}

/**
 * Parses the `previewUrls` JSON object returned by the server into a
 * `Map<number, string>`. String keys (port numbers) are converted to integers.
 * The URL values are treated as opaque — not parsed or reconstructed.
 *
 * Returns an empty Map when the server response omits `previewUrls` (fail-closed:
 * every `getUrl()` call will throw `SandboxPortNotProvisionedError`).
 *
 * @param {object|null|undefined} raw the `previewUrls` field from the API response
 * @returns {Map<number, string>}
 */
function parsePreviewUrls (raw) {
  if (!raw || typeof raw !== 'object') {
    return new Map()
  }
  const map = new Map()
  for (const [key, value] of Object.entries(raw)) {
    const port = Number(key)
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && typeof value === 'string') {
      map.set(port, value)
    }
  }
  return map
}

module.exports = Sandbox
