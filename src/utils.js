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

const {
  SandboxClientError,
  SandboxInitializationError,
  SandboxNotFoundError,
  SandboxUnauthorizedError,
  SandboxTimeoutError
} = require('./errors')
const { SANDBOX_SIZES, API_PREFIX } = require('./constants')

const SANDBOX_REGION_PATTERN = /^[a-z]{2,4}[0-9]{1,2}$/i
const CANONICAL_SANDBOX_API_HOSTNAME = 'sandbox-adobeioruntime.net'

/**
 * Builds a Basic authorization header from a Runtime API key.
 *
 * @param {string} apiKey Runtime API key
 * @returns {string} Basic authorization header value
 */
function buildAuthorizationHeader (apiKey) {
  return `Basic ${Buffer.from(apiKey).toString('base64')}`
}

/**
 * Maps sandbox management API status codes to SDK error classes.
 *
 * @param {number} status HTTP response status
 * @param {string} message error message
 * @returns {SandboxClientError} SDK error matching the response status
 */
function createSandboxHttpError (status, message) {
  if (status === 401 || status === 403) {
    return new SandboxUnauthorizedError(message)
  }
  if (status === 404) {
    return new SandboxNotFoundError(message)
  }
  if (status === 504) {
    return new SandboxTimeoutError(message)
  }
  return new SandboxClientError(message)
}

/**
 * Ensures the Runtime API host has a URL scheme.
 *
 * @param {string} host Runtime API host
 * @returns {string} API host with a URL scheme
 */
function normalizeApiHost (host) {
  if (!host.match(/^https?:\/\//)) {
    return `https://${host}`
  }
  return host
}

/**
 * Validates and normalizes a Runtime region identifier.
 *
 * @param {string} region Runtime region identifier
 * @returns {string} lowercase Runtime region identifier
 */
function normalizeRegion (region) {
  if (typeof region !== 'string' || !SANDBOX_REGION_PATTERN.test(region)) {
    throw new SandboxClientError(
      "Invalid sandbox region provided: expected 2-4 letters followed by 1-2 digits (for example, 'va6', 'irl1', 'jpn3', or 'aus3')"
    )
  }
  return region.toLowerCase()
}

/**
 * Routes canonical sandbox API hosts directly to the requested region.
 *
 * Custom, already-regional, and non-bare API hosts are returned unchanged.
 *
 * @param {string} apiHost normalized Runtime API host
 * @param {string|undefined} region normalized Runtime region identifier
 * @returns {string} effective Runtime API host
 */
function routeSandboxApiHost (apiHost, region) {
  if (region === undefined) return apiHost

  const url = new URL(apiHost)
  const isCanonicalBareHost =
    url.protocol === 'https:' &&
    url.hostname === CANONICAL_SANDBOX_API_HOSTNAME &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''

  if (!isCanonicalBareHost) return apiHost
  return `https://${region}.${url.hostname}`
}

/**
 * Builds the sandbox execution WebSocket endpoint from Runtime API details.
 *
 * @param {string} apiHost Runtime API host
 * @param {string} namespace Runtime namespace
 * @param {string} sandboxId sandbox id
 * @returns {string} sandbox WebSocket endpoint
 */
function buildWebSocketEndpoint (apiHost, namespace, sandboxId) {
  const url = new URL(apiHost)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = `${API_PREFIX}/namespaces/${namespace}/sandboxes/${sandboxId}/exec`
  url.search = ''
  return url.toString()
}

/**
 * Reads Runtime credentials from environment variables, merged with any
 * explicit overrides. Throws `SandboxInitializationError` for missing values.
 *
 * @param {object} overrides explicit credential overrides
 * @returns {{ apiHost: string, namespace: string, apiKey: string }} resolved Runtime credentials
 */
function resolveCredentials (overrides = {}) {
  const apiHost = overrides.apiHost || process.env.__OW_API_HOST
  const namespace = overrides.namespace || process.env.__OW_NAMESPACE
  const apiKey = overrides.auth || process.env.__OW_API_KEY

  const missing = []
  if (!apiHost) missing.push('apiHost')
  if (!namespace) missing.push('namespace')
  if (!apiKey) missing.push('auth')

  if (missing.length > 0) {
    throw new SandboxInitializationError(
      `Missing required credentials: ${missing.join(', ')}. ` +
      'Pass them explicitly or set __OW_API_HOST, __OW_NAMESPACE, __OW_API_KEY in the environment.'
    )
  }

  return { apiHost: normalizeApiHost(apiHost), namespace, apiKey }
}

/**
 * @param {string|object|undefined} size size name or spec object
 * @returns {string} normalised size name
 */
function normalizeSize (size) {
  if (!size) return 'MEDIUM'

  if (typeof size === 'string' && SANDBOX_SIZES[size]) return size

  if (typeof size === 'object') {
    const entry = Object.entries(SANDBOX_SIZES).find(
      ([, v]) => v.cpu === size.cpu && v.memory === size.memory && v.gpu === size.gpu
    )
    if (entry) return entry[0]
  }

  throw new SandboxClientError('Invalid sandbox size provided')
}

/**
 * Thin fetch wrapper around the management REST API.
 *
 * Uses the Node.js global `fetch` (available since Node 18).
 *
 * @param {string} method HTTP method
 * @param {string} url full request URL
 * @param {string} apiKey API key for Basic auth
 * @param {object|undefined} body request body (JSON-encoded when present)
 * @returns {Promise<object>} parsed response JSON
 */
async function apiRequest (method, url, apiKey, body) {
  const headers = { Authorization: buildAuthorizationHeader(apiKey) }
  const init = { method, headers }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new SandboxClientError(`Sandbox API request failed: ${error.message}`)
  }

  if (!response.ok) {
    const text = await response.text()
    const detail = `${response.status}${text ? ` ${text}` : ''}`
    throw createSandboxHttpError(response.status, detail)
  }

  return response.json()
}

module.exports = {
  buildAuthorizationHeader,
  createSandboxHttpError,
  normalizeApiHost,
  normalizeRegion,
  routeSandboxApiHost,
  buildWebSocketEndpoint,
  resolveCredentials,
  normalizeSize,
  apiRequest
}
