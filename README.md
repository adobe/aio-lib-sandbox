# App Builder Sandbox SDK

[![Version](https://img.shields.io/npm/v/@adobe/aio-lib-sandbox.svg)](https://npmjs.org/package/@adobe/aio-lib-sandbox)
[![Downloads/week](https://img.shields.io/npm/dw/@adobe/aio-lib-sandbox.svg)](https://npmjs.org/package/@adobe/aio-lib-sandbox)
![Node.js CI](https://github.com/adobe/aio-lib-sandbox/workflows/Node.js%20CI/badge.svg)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Codecov Coverage](https://img.shields.io/codecov/c/github/adobe/aio-lib-sandbox/main.svg?style=flat-square)](https://codecov.io/gh/adobe/aio-lib-sandbox/)

JavaScript SDK for Adobe Runtime Sandboxes.

A **sandbox** is an ephemeral, isolated compute environment. You create one, run commands and read/write files inside it over a WebSocket session, then destroy it.

## Pre-requisites

To use this library, you must have Sandboxes enabled for your Runtime namespace. Please contact Michael Goberling (mgoberling@adobe.com) or Cosmin Stanciu (stanciu@adobe.com) to request this. 

## Install

```bash
npm install @adobe/aio-lib-sandbox
```

## Quickstart

Inside a Runtime action, no configuration is needed to use the SDK as credentials are read automatically from the environment.

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
  idleTimeout: 900,
  maxLifetime: 3600,
  ports:       [3000, 8080],
  envs:        { API_KEY: 'your-api-key' }
})
```

#### Sandbox lifetime model

A sandbox is always deleted when `maxLifetime` has elapsed. It will also be deleted after the `idleTimeout` has elapsed, if there has been no activity.

To keep a sandbox alive, send at least one command or check the status every `idleTimeout` seconds.

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

### Detached Commands

Pass `detached: true` to run a long-lived background process.

```js
// Start a background server
const command = await sandbox.exec('node server.js', { detached: true })

// Wait for it to exit (e.g. after you stop it)
const result = await command.wait()
console.log('exit code:', result.exitCode)

// Send a signal to stop it
await command.kill()
```

If the process is still running and you need a handle to it from a different context, use `getCommand()` to re-attach by `execId`:

```js
const command = await sandbox.getCommand(execId, { onOutput: (data, stream) => process.stdout.write(data) })
await command.wait()
```

> Note: Only 5 background processes are allowed to run at once currently.

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

Ports that should be publicly accessible must be declared at creation time via the `ports` array.

```js
const sandbox = await Sandbox.create({
  name:  'web-sandbox',
  ports: [3000, 8080]
})

// Start a server inside the sandbox on the declared port
await sandbox.exec('node server.js &', { timeout: 50_000 })

// Retrieve the pre-provisioned preview URL — synchronous, no network call
const url = sandbox.getUrl(3000)
console.log('preview:', url)
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

## Development

Install development dependencies:

```bash
npm install
```

To run the same checks used by CI:

```bash
npm test
```

Linting is powered by ESLint:

```bash
npm run lint
npm run lint-fix
```
