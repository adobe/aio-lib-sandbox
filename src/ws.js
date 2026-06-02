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

const WebSocket = require('ws')
const {
  SandboxClientError,
  SandboxCommandNotFoundError,
  SandboxUnauthorizedError,
  SandboxWebSocketError
} = require('./errors')

/**
 * Manages the WebSocket connection, authentication, and frame routing for a sandbox.
 *
 * Holds the raw socket, all pending exec and file-op promises, and handles every
 * incoming message. `Sandbox` creates one instance and delegates all WS work here.
 */
class SandboxSocket {
  /**
   * @param {object} options socket options
   * @param {string} options.id sandbox id
   * @param {string} options.endpoint WebSocket endpoint URL
   * @param {string} options.token authentication token
   */
  constructor ({ id, endpoint, token }) {
    this.id = id
    this.endpoint = endpoint
    this.token = token

    this.socket = null
    this.connectPromise = null
    this.intentionalClose = false

    /**
     * Pending exec entries
     *
     * @type {Map<string, {
     *   resolve: Function, reject: Function,
     *   waitResolve: Function|null, waitReject: Function|null,
     *   stdout: string, stderr: string,
     *   onOutput: Function|undefined, timeout: any,
     *   detached: boolean, resolved: boolean
     * }>}
     */
    this.pendingExecs = new Map()
    /** @type {Map<string, {resolve: Function, reject: Function}>} */
    this.pendingFileOps = new Map()
    /**
     * Pending exec.get operations keyed by execId.
     * @type {Map<string, {resolve: Function, reject: Function, onOutput: Function|undefined, sandbox: object}>}
     */
    this.pendingGetOps = new Map()
  }

  /**
   * Opens the WebSocket, authenticates, and starts routing messages
   *
   * @returns {Promise<void>}
   */
  connect () {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.socket = new WebSocket(this.endpoint)
    const socket = this.socket

    socket.on('message', message => this.handleMessage(message))
    socket.on('close', code => this.handleClose(code))
    socket.on('error', () => {})

    this.connectPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        try {
          this.send({ type: 'auth', token: this.token })
        } catch (error) {
          onError(error)
        }
      }

      const onMessage = (message) => {
        const frame = this.parseFrame(message)
        if (!frame || !this.isAuthAckFrame(frame)) return
        cleanup()
        this.connectPromise = null
        resolve()
      }

      const onClose = (code) => {
        cleanup()
        this.connectPromise = null
        if (this.intentionalClose) {
          resolve()
          return
        }
        reject(this.createCloseError(code))
      }

      const onError = (error) => {
        cleanup()
        this.connectPromise = null
        reject(new SandboxWebSocketError(
          `Could not connect sandbox '${this.id}': ${error.message}`
        ))
      }

      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('message', onMessage)
        socket.off('close', onClose)
        socket.off('error', onError)
      }

      socket.once('open', onOpen)
      socket.on('message', onMessage)
      socket.once('close', onClose)
      socket.once('error', onError)
    })

    return this.connectPromise
  }

  /**
   * Throws `SandboxWebSocketError` if the socket is not currently open.
   */
  ensureOpen () {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new SandboxWebSocketError(`Sandbox '${this.id}' is not connected`)
    }
  }

  /**
   * Serialises `frame` and sends it over the socket.
   *
   * @param {object} frame WebSocket frame to send
   */
  send (frame) {
    this.socket.send(JSON.stringify(frame))
  }

  /**
   * Marks the next socket close as expected by the caller.
   */
  beginIntentionalClose () {
    this.intentionalClose = true
  }

  /**
   * Clears a previously requested intentional close.
   */
  cancelIntentionalClose () {
    this.intentionalClose = false
  }

  /**
   * Closes the underlying socket.
   *
   * @param {object} [options] close options
   * @param {boolean} [options.intentional] whether pending work should be drained without error
   */
  close ({ intentional = false } = {}) {
    if (intentional) this.beginIntentionalClose()
    this.socket?.close()
  }

  // ------------------------------------------------------------------
  // Pending operation helpers
  // ------------------------------------------------------------------

  /**
   * Registers a pending exec, sends the frame, and returns the promises
   * that will be settled by subsequent result or ack frames (for detached)
   *
   * @param {string} execId execution id for the pending command
   * @param {object} frame the frame to send (must include `type` and `execId`)
   * @param {{ detached: boolean, onOutput?: Function }} options pending exec options
   * @returns {{ ackPromise: Promise, waitPromise: Promise|null }} promises for ack and optional completion
   */
  sendExec (execId, frame, { detached, onOutput }) {
    let waitResolve, waitReject, waitPromise
    if (detached) {
      waitPromise = new Promise((resolve, reject) => { waitResolve = resolve; waitReject = reject })
    }

    let resolve, reject
    const ackPromise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })

    this.pendingExecs.set(execId, {
      resolve,
      reject,
      waitResolve: waitResolve || null,
      waitReject: waitReject || null,
      _waitPromise: waitPromise || null,
      stdout: '',
      stderr: '',
      onOutput: onOutput || null,
      timeout: undefined,
      detached,
      resolved: false
    })

    try {
      this.send(frame)
    } catch (error) {
      this.rejectExec(execId, new SandboxWebSocketError(
        `Could not send exec frame: ${error.message}`
      ))
    }

    return { ackPromise, waitPromise: waitPromise || null }
  }

  /**
   * Stores a timer handle on a pending exec entry so it can be cleared on completion.
   *
   * @param {string} execId execution id for the pending command
   * @param {ReturnType<setTimeout>} handle timeout handle to store
   */
  setExecTimeout (execId, handle) {
    const entry = this.pendingExecs.get(execId)
    if (entry) entry.timeout = handle
  }

  /**
   * Rejects and removes a pending exec, clearing its timeout.
   *
   * @param {string} execId execution id for the pending command
   * @param {Error} error error used to reject the command
   */
  rejectExec (execId, error) {
    const pending = this.pendingExecs.get(execId)
    if (!pending) return
    this.pendingExecs.delete(execId)
    clearTimeout(pending.timeout)

    // For detached execs, the first promise is always resolved, so reject the wait promise instead
    if (pending.detached && pending.resolved) {
      if (pending.waitReject) pending.waitReject(error)
    } else {
      pending.reject(error)
    }
  }

  /**
   * Rejects and removes a pending file operation.
   *
   * @param {string} execId file operation id
   * @param {Error} error error used to reject the file operation
   */
  rejectFileOp (execId, error) {
    const pending = this.pendingFileOps.get(execId)
    if (!pending) return
    this.pendingFileOps.delete(execId)
    pending.reject(error)
  }

  /**
   * Resolves and removes a pending exec during an intentional sandbox shutdown.
   *
   * @param {string} execId execution id for the pending command
   */
  resolveExecOnIntentionalClose (execId) {
    const pending = this.pendingExecs.get(execId)
    if (!pending) return
    this.pendingExecs.delete(execId)
    clearTimeout(pending.timeout)

    const result = { exitCode: null, destroyed: true }
    if (pending.detached) {
      if (!pending.resolved) {
        pending.resolved = true
        pending.resolve({ pid: undefined, startedAt: undefined, destroyed: true })
      }
      if (pending.waitResolve) pending.waitResolve(result)
      return
    }

    pending.resolve({
      execId,
      stdout: pending.stdout,
      stderr: pending.stderr,
      ...result
    })
  }

  handleMessage (message) {
    const frame = this.parseFrame(message)
    if (!frame || this.isAuthAckFrame(frame)) return

    if (frame.type === 'exec.info' ||
        (frame.type === 'error' && this.pendingGetOps.has(frame.execId))) {
      this.handleGetFrame(frame)
      return
    }

    if (this.pendingFileOps.has(frame.execId)) {
      this.handleFileFrame(frame)
      return
    }

    if (this.pendingExecs.has(frame.execId)) {
      this.handleExecFrame(frame)
    }
  }

  handleClose (code) {
    if (this.intentionalClose) {
      for (const execId of [...this.pendingExecs.keys()]) {
        this.resolveExecOnIntentionalClose(execId)
      }
      for (const [, pending] of [...this.pendingFileOps.entries()]) {
        pending.resolve(undefined)
      }
      for (const [, pending] of [...this.pendingGetOps.entries()]) {
        pending.resolve(null)
      }
      this.pendingFileOps.clear()
      this.pendingGetOps.clear()
      this.connectPromise = null
      this.socket = null
      this.intentionalClose = false
      return
    }

    const error = this.createCloseError(code)
    for (const execId of [...this.pendingExecs.keys()]) {
      this.rejectExec(execId, error)
    }
    for (const execId of [...this.pendingFileOps.keys()]) {
      this.rejectFileOp(execId, error)
    }
    for (const [, pending] of [...this.pendingGetOps.entries()]) {
      pending.reject(error)
    }
    this.pendingGetOps.clear()
    this.connectPromise = null
    this.socket = null
  }

  createCloseError (code) {
    if (code === 4001) {
      return new SandboxUnauthorizedError(
        `Sandbox '${this.id}' rejected the WebSocket authentication token`
      )
    }
    return new SandboxWebSocketError(
      `Sandbox '${this.id}' WebSocket closed with code ${code}`
    )
  }

  parseFrame (message) {
    try {
      return JSON.parse(message.toString())
    } catch (_) {
      return null
    }
  }

  isAuthAckFrame (frame) {
    return frame?.type === 'auth.ok' && (!frame.sandboxId || frame.sandboxId === this.id)
  }

  // ------------------------------------------------------------------
  // Frame routing
  // ------------------------------------------------------------------

  handleExecFrame (frame) {
    const pending = this.pendingExecs.get(frame.execId)
    if (!pending) return

    if (frame.type === 'exec.output') {
      if (frame.stream === 'stderr') {
        pending.stderr += frame.data || ''
      } else {
        pending.stdout += frame.data || ''
      }
      if (pending.onOutput) {
        pending.onOutput(frame.data || '', frame.stream || 'stdout')
      }
      return
    }

    // For detached cmds, we will resolve with the server response, which is all the command info needed for a
    // handle. The entry stays in pendingExecs to receive subsequent output and exec.exit.
    if (frame.type === 'exec.detached') {
      clearTimeout(pending.timeout)
      pending.timeout = undefined
      pending.resolved = true
      pending.resolve({ pid: frame.pid, startedAt: frame.startedAt })
      return
    }

    if (frame.type === 'exec.exit') {
      this.pendingExecs.delete(frame.execId)
      clearTimeout(pending.timeout)
      if (pending.detached && pending.resolved) {
        // For detached, the initial ack promise already resolved, so we resolve the wait promise
        if (pending.waitResolve) {
          pending.waitResolve({ exitCode: frame.exitCode })
        }
      } else {
        pending.resolve({
          execId: frame.execId,
          stdout: pending.stdout,
          stderr: pending.stderr,
          exitCode: frame.exitCode
        })
      }
      return
    }

    if (frame.type === 'error') {
      this.rejectExec(frame.execId, new SandboxClientError(
        frame.message || `Command '${frame.execId}' failed`
      ))
    }
  }

  handleFileFrame (frame) {
    const pending = this.pendingFileOps.get(frame.execId)
    if (!pending) return

    if (frame.type === 'file.content') {
      this.pendingFileOps.delete(frame.execId)
      const content = frame.encoding === 'base64'
        ? Buffer.from(frame.content, 'base64').toString('utf8')
        : (frame.content || '')
      pending.resolve(content)
      return
    }

    if (frame.type === 'file.writeResult') {
      this.pendingFileOps.delete(frame.execId)
      if (!frame.ok) {
        pending.reject(new SandboxClientError(
          `file.write failed for path '${frame.path}'`
        ))
      } else {
        pending.resolve({ path: frame.path, size: frame.size, ok: frame.ok })
      }
      return
    }

    if (frame.type === 'file.entries') {
      this.pendingFileOps.delete(frame.execId)
      pending.resolve(frame.entries || [])
      return
    }

    if (frame.type === 'error') {
      this.rejectFileOp(frame.execId, new SandboxClientError(
        frame.message || `File operation '${frame.execId}' failed`
      ))
    }
  }

  /**
   * Handles exec.info (response to exec.get) and error frames routed from handleMessage.
   *
   * @param {object} frame exec.get response or error frame
   */
  handleGetFrame (frame) {
    const pending = this.pendingGetOps.get(frame.execId)
    if (!pending) return

    if (frame.type === 'exec.info') {
      this.resolveGetOp(frame, pending)
      return
    }

    if (frame.type === 'error') {
      this.rejectGetOp(frame, pending)
    }
  }

  /**
   * Resolves a pending exec.get by building a command handle and resolving the caller's promise.
   *
   * @param {object} frame exec.info frame
   * @param {object} pending entry from pendingGetOps
   */
  resolveGetOp (frame, pending) {
    this.pendingGetOps.delete(frame.execId)
    const waitPromise = this.resolveExecEntry(frame, pending)
    const commandObj = this.buildCommandObject(frame, waitPromise, pending.sandbox)
    pending.resolve(commandObj)
  }

  /**
   * Rejects a pending exec.get with a not-found error.
   *
   * @param {object} frame error frame
   * @param {object} pending entry from pendingGetOps
   */
  rejectGetOp (frame, pending) {
    this.pendingGetOps.delete(frame.execId)
    pending.reject(new SandboxCommandNotFoundError(
      frame.message || `No running process for execId '${frame.execId}'`
    ))
  }

  /**
   * Returns the wait promise for the exec, either by reusing an existing pendingExecs entry
   * (same session) or by registering a fresh reattached entry (new session / previous connection).
   *
   * @param {object} frame exec.info frame
   * @param {object} pending entry from pendingGetOps
   * @returns {Promise} wait promise for the running command
   */
  resolveExecEntry (frame, pending) {
    const existingExec = this.pendingExecs.get(frame.execId)
    if (existingExec) {
      existingExec.onOutput = this.mergeOnOutputCallback(existingExec.onOutput, pending.onOutput)
      return existingExec._waitPromise
    }
    return this.registerReattachedExec(frame, pending.onOutput)
  }

  /**
   * Appends `onOutput` to an existing exec entry's callback chain, preserving the previous handler.
   *
   * @param {Function|null|undefined} prev existing callback
   * @param {Function|undefined} onOutput new callback to add
   * @returns {Function|null|undefined} merged callback
   */
  mergeOnOutputCallback (prev, onOutput) {
    if (!onOutput) return prev
    return (data, stream) => {
      if (prev) prev(data, stream)
      onOutput(data, stream)
    }
  }

  /**
   * Creates a fresh pendingExecs entry for a process reattached from a previous connection,
   * registers it, and returns its wait promise.
   *
   * @param {object} frame exec.info frame
   * @param {Function|undefined} onOutput output callback
   * @returns {Promise} wait promise for the reattached command
   */
  registerReattachedExec (frame, onOutput) {
    let waitResolve, waitReject
    const waitPromise = new Promise((resolve, reject) => { waitResolve = resolve; waitReject = reject })
    this.pendingExecs.set(frame.execId, {
      resolve: () => {},
      reject: () => {},
      waitResolve,
      waitReject,
      _waitPromise: waitPromise,
      stdout: '',
      stderr: '',
      onOutput: onOutput || null,
      timeout: undefined,
      detached: frame.detached,
      resolved: true
    })
    return waitPromise
  }

  /**
   * Builds the command handle object returned to the caller of exec.get.
   *
   * @param {object} frame exec.info frame
   * @param {Promise} waitPromise resolves when the process exits
   * @param {object} sandbox Sandbox instance for delegating control operations
   * @returns {object} command handle with wait and control helpers
   */
  buildCommandObject (frame, waitPromise, sandbox) {
    const { execId } = frame
    return {
      execId,
      command: frame.command,
      pid: frame.pid,
      startedAt: frame.startedAt,
      detached: frame.detached,
      wait: () => waitPromise,
      writeStdin: (data) => sandbox.writeStdin(execId, data),
      closeStdin: () => sandbox.closeStdin(execId),
      kill: (signal) => sandbox.kill(execId, signal)
    }
  }
}

module.exports = { SandboxSocket }
