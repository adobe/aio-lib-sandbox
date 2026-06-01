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
  SandboxWebSocketError
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
  constructor(options) {
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
    this.publicUrlTemplate = options.publicUrlTemplate || null
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
   * @param {object} [options.envs] environment variables to inject into the sandbox
   * @param {object} [options.policy] network policy (e.g. egress allowlist)
   * @returns {Promise<Sandbox>} connected sandbox instance
   */
  static async create(options = {}) {
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
      publicUrlTemplate: payload.publicUrlTemplate || null,
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
  static async get(sandboxId, options = {}) {
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
  static get sizes() {
    return SANDBOX_SIZES
  }

  /**
   * Exposes `resolveCredentials` as a static helper (useful for testing).
   *
   * @param {object} overrides credential overrides
   * @returns {{ apiHost: string, namespace: string, apiKey: string }}
   */
  static resolveCredentials(overrides = {}) {
    return resolveCredentials(overrides)
  }

  /**
   * Exposes `normalizeSize` as a static helper (useful for testing).
   *
   * @param {string|object|undefined} size
   * @returns {string}
   */
  static normalizeSize(size) {
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
  connect() {
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
   * `options.timeout` is not supported with `options.detached: true`.
   *
   * @param {string} command command to run
   * @param {object} [options] execution options
   * @param {number} [options.timeout] timeout in milliseconds (foreground only)
   * @param {boolean} [options.detached] when true, run as a detached background process
   * @param {string|Buffer} [options.stdin] data to send to stdin at startup
   * @param {function} [options.onOutput] callback called with `(data, stream)` for each output chunk
   * @returns {Promise}
   */
  exec(command, options = {}) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    if (options.detached && options.timeout) {
      return Promise.reject(new SandboxClientError(
        'cannot set a timeout for a detached command'
      ))
    }

    const execId = `exec-${crypto.randomBytes(12).toString('hex')}`
    const promise = this.sendExecFrameAndAwaitResponse(execId, command, options)
    promise.execId = execId
    return promise
  }

  /**
   * @param {string} execId
   * @param {string} command
   * @param {object} options
   * @private
   */
  async sendExecFrameAndAwaitResponse(execId, command, options) {
    const detached = !!options.detached
    const frame = { type: 'exec.run', execId, command, ...(detached && { detached: true }) }

    const { ackPromise, waitPromise } = this.ws.sendExec(execId, frame, {
      detached,
      onOutput: options.onOutput
    })

    if (options.timeout) {
      this.ws.setExecTimeout(execId, this.scheduleTimeout(execId, command, options.timeout))
    }

    if (options.stdin !== undefined) {
      this.writeStdin(execId, options.stdin)
      this.closeStdin(execId)
    }

    const result = await ackPromise

    if (!detached) return result

    const { pid, startedAt } = result
    return {
      execId,
      pid,
      startedAt,
      detached: true,
      wait: () => waitPromise,
      writeStdin: (data) => this.writeStdin(execId, data),
      closeStdin: () => this.closeStdin(execId),
      kill: (signal) => this.kill(execId, signal)
    }
  }

  /**
   * Re-attaches to a detached command that is still running in the sandbox.
   *
   * @param {string} execId the execId returned by the original `exec()` call
   * @param {object} [options] re-attach options
   * @param {function} [options.onOutput] callback called with `(data, stream)` for live output
   * @returns {Promise<{execId, command, pid, startedAt, detached, wait, kill, writeStdin, closeStdin}>}
   */
  getCommand(execId, options = {}) {
    try {
      this.ensureOpen()
    } catch (error) {
      return Promise.reject(error)
    }

    const getPromise = new Promise((resolve, reject) => {
      this.ws.pendingGetOps.set(execId, {
        resolve,
        reject,
        onOutput: options.onOutput || null,
        sandbox: this
      })
    })

    try {
      this.sendFrame({ type: 'exec.get', execId })
    } catch (error) {
      this.ws.pendingGetOps.delete(execId)
      return Promise.reject(new SandboxWebSocketError(
        `Could not send exec.get frame: ${error.message}`
      ))
    }

    return getPromise
  }

  /**
   * Sends a signal to a running command.
   *
   * @param {string} execId execution id
   * @param {string} [signal] signal to deliver (default: `'SIGTERM'`)
   */
  kill(execId, signal = 'SIGTERM') {
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
  writeStdin(execId, data) {
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
  closeStdin(execId) {
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
  readFile(path) {
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
  writeFile(path, content) {
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
  listFiles(path) {
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
   * @param {object} options URL options
   * @param {number} options.port port number (1–65535)
   * @param {string} [options.protocol] override the URL scheme (e.g. `'wss'`)
   * @returns {Promise<string>} public preview URL
   */
  async getUrl({ port, protocol } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxClientError(
        `Cannot get URL for sandbox '${this.id}': publicUrlTemplate is not available`
      )
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxClientError(
        `Invalid port '${port}': must be an integer between 1 and 65535`
      )
    }

    let url = this.publicUrlTemplate
      .replace('{sandboxId}', this.id)
      .replace('{port}', String(port))

    if (protocol) {
      url = url.replace(/^https?:\/\//, `${protocol}://`)
    }

    return url
  }

  /**
   * Destroys the sandbox and closes its WebSocket connection.
   *
   * @returns {Promise<object>} destroy response payload
   */
  async destroy() {
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

  /**
   * Schedules a timeout that kills `execId` and rejects its pending entry.
   *
   * @param {string} execId
   * @param {string} command human-readable command string (for the error message)
   * @param {number} ms timeout in milliseconds
   * @returns {ReturnType<setTimeout>} the timer handle (stored on the entry for cancellation)
   */
  scheduleTimeout(execId, command, ms) {
    return setTimeout(() => {
      try {
        this.kill(execId)
      } catch (_) {
        // ignore errors
      }
      
      this.ws.rejectExec(execId, new SandboxTimeoutError(
        `Command '${command}' exceeded timeout of ${ms}ms`
      ))
    }, ms)
  }

  ensureOpen() {
    if (!this.ws) {
      throw new SandboxWebSocketError(`Sandbox '${this.id}' is not connected`)
    }
    this.ws.ensureOpen()
  }

  sendFrame(frame) {
    this.ws.send(frame)
  }
}

module.exports = Sandbox
