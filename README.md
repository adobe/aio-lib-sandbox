# App Builder Sandbox SDK

[![Version](https://img.shields.io/npm/v/@adobe/aio-lib-sandbox.svg)](https://npmjs.org/package/@adobe/aio-lib-sandbox)
[![Downloads/week](https://img.shields.io/npm/dw/@adobe/aio-lib-sandbox.svg)](https://npmjs.org/package/@adobe/aio-lib-sandbox)
![Node.js CI](https://github.com/adobe/aio-lib-sandbox/workflows/Node.js%20CI/badge.svg)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Codecov Coverage](https://img.shields.io/codecov/c/github/adobe/aio-lib-sandbox/main.svg?style=flat-square)](https://codecov.io/gh/adobe/aio-lib-sandbox/)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

JavaScript SDK for Adobe Runtime Sandboxes.

A **sandbox** is an ephemeral, isolated compute environment. You create one, run commands and read/write files inside it over a WebSocket session, then destroy it.

> [!WARNING]
> **Alpha.** This SDK is in active alpha development. The API surface and authentication model may change without notice. Pin exact versions; do not rely on `latest`.

## Pre-requisites

To use this library, you must have Sandboxes enabled for your Runtime namespace. Please contact Michael Goberling (mgoberling@adobe.com) or Cosmin Stanciu (stanciu@adobe.com) to request this. 

## Install

```bash
npm install @adobe/aio-lib-sandbox@alpha
```

## Quickstart

Inside a Runtime action, credentials are read automatically from the environment.

```js
const { Sandbox } = require('@adobe/aio-lib-sandbox')

async function main (params) {
  const sandbox = await Sandbox.create({ name: 'my-sandbox' })

  const { stdout } = await sandbox.exec('node --version', { timeout: 10_000 })

  await sandbox.destroy()
  return { stdout: stdout.trim() }
}

exports.main = main
```

## Configuration

When running inside a Runtime action, the SDK reads credentials from the environment automatically:

| Variable | Description |
|---|---|
| `__OW_API_HOST` | Runtime API host |
| `__OW_NAMESPACE` | Runtime namespace |
| `__OW_API_KEY` | Runtime API key (basic auth) |

You can override any of these by passing them explicitly to `Sandbox.create()` or `Sandbox.get()`:

```js
const sandbox = await Sandbox.create({
  apiHost:   'https://adobeioruntime.net',
  namespace: 'my-namespace',
  auth:    'my-api-key',
  name:      'my-sandbox'
})
```

## Usage

### Create Sandbox

```js
const { Sandbox } = require('@adobe/aio-lib-sandbox')

const sandbox = await Sandbox.create({
  name:        'my-sandbox',
  type:        'cpu:default',
  maxLifetime: 3600,
  envs:        { API_KEY: 'your-api-key' }
})
```

### Get Status

```js
const sandbox = await Sandbox.get(sandbox.id)
console.log('status:', sandbox.status)
```

### Exec

```js
const result = await sandbox.exec('ls -al', { timeout: 10_000 })
console.log('stdout:', result.stdout.trim())
console.log('exit code:', result.exitCode)
```

> Note: Commands run in the `/workspace` directory by default, this is not configurable

### File Management

```js
const script = "console.log('hello from sandbox script', process.version)\n"
await sandbox.writeFile('hello.js', script)

const content = await sandbox.readFile('hello.js')
console.log('readFile content:', content.trim())

const entries = await sandbox.listFiles('.')
console.log('listFiles entries:', entries)
```

### Exec a File

```js
const result = await sandbox.exec('node hello.js', { timeout: 10_000 })
console.log('stdout:', result.stdout.trim())
console.log('stderr:', result.stderr.trim())
console.log('exit code:', result.exitCode)
```

### Write to Stdin

#### Command start
```js
const result = await sandbox.exec('node process_csv.js', {
  stdin: 'col1,col2\nval1,val2\n',
  timeout: 10_000
})
console.log('stdout:', result.stdout.trim())
```

#### Running command
```js
const task = sandbox.exec('cat -n', { timeout: 10_000 })

sandbox.writeStdin(task.execId, 'line 1\n')
sandbox.writeStdin(task.execId, 'line 2\n')
sandbox.closeStdin(task.execId)

const result = await task
console.log('stdout:', result.stdout.trim())
```

### Destroy

```js
await sandbox.destroy()
```

### Preview URLs

Use preview URLs to get access to servers or web services running in a sandbox on a particular port: 

```js
const url = await sandbox.getUrl({port: 3000})
console.log("preview:", url)
// https://sb-abc123-va6-0-xK3mPq2nAeB-3000.sandbox-adobeioruntime.net
```

## Network Policies

Sandboxes are default-deny. All outbound traffic is blocked unless explicitly allowed.

Pass a `policy.network.egress` array at creation time to allowlist outbound endpoints, paths, or HTTP verbs.

```js
const sandbox = await Sandbox.create({
  name:        'policy-sandbox',
  maxLifetime: 300,
  policy: {
    network: {
      egress: [
        { host: 'httpbin.org', port: 443 },
        {
          host: 'api.github.com',
          port: 443,
          rules: [
            { methods: ['GET'], pathPattern: '/repos/**' }
          ]
        }
      ]
    }
  }
})
```
