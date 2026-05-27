# Adobe I/O Runtime Sandbox — Interactive CLI

An interactive CLI for creating and exploring [Adobe I/O Runtime compute sandboxes](https://github.com/adobe/aio-lib-sandbox).

> [!WARNING]
> **Alpha.** The underlying SDK is in active alpha development. The API surface and authentication model may change without notice.

## Pre-requisites

Sandboxes must be enabled for your Runtime namespace. Contact Michael Goberling (mgoberling@adobe.com) or Cosmin Stanciu (stanciu@adobe.com) to request access.

## Usage

```bash
npx github:adobe/aio-lib-sandbox/run --type cpu:default
```

Credentials are read from environment variables or prompted interactively on first run:

| Variable | Description |
|---|---|
| `AIO_RUNTIME_APIHOST` | Runtime API host (default: `https://adobeioruntime.net`) |
| `AIO_RUNTIME_NAMESPACE` | Your Runtime namespace |
| `AIO_RUNTIME_AUTH` | Your Runtime API key |

Copy `.env.example` to `.env` in your working directory to avoid typing credentials each time.

## Flags

| Flag | Short | Description |
|---|---|---|
| `--namespace` | `-n` | Runtime namespace |
| `--apihost` | `-H` | Runtime API host |
| `--api-key` | `-k` | Runtime API key |
| `--type` | `-t` | Sandbox type (e.g. `cpu:default`, `cpu:large`) |
| `--size` | `-s` | Sandbox size |
| `--egress` | `-e` | Egress rule(s) — repeatable (see below) |
| `--port` | `-p` | Print a preview URL for this port at startup — repeatable |

## Egress rules

Sandboxes are default-deny. Use `--egress` to allowlist outbound endpoints:

```bash
# Single rule
npx github:adobe/aio-lib-sandbox/run --egress "api.github.com:443"

# Multiple rules
npx github:adobe/aio-lib-sandbox/run \
  --egress "httpbin.org:443" \
  --egress "api.github.com:443|GET:/repos/**"

# Allow all outbound traffic
npx github:adobe/aio-lib-sandbox/run --egress allow-all
```

**Format:** `host:port[:TCP|UDP][|METHOD[,METHOD]:/path/pattern]`

## Preview URLs

Use `--port` to print preview URLs for servers running inside the sandbox:

```bash
npx github:adobe/aio-lib-sandbox/run --port 3000 --port 5173
```

## REPL commands

Once the sandbox is created, you get an interactive REPL:

| Command | Description |
|---|---|
| `<any shell command>` | Run command on the sandbox |
| `cmd <<< "text"` | Send inline text as stdin |
| `.help` | Show help |
| `exit` / `quit` | Destroy sandbox and exit |

> **Note:** Each command runs in a fresh process. Shell state (working directory, exports) does not persist between commands. Chain commands to work around this: `cd mydir && npm install`.
