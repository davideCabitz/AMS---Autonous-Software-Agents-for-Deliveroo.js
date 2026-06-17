# Getting Started

## Prerequisites

- Node.js ≥ 18 (ESM support required — the project uses `"type": "module"`)
- A running Deliveroo.js server instance
- A JWT token issued by the server for each agent

## Install

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in the required fields.

```
TOKEN=your_jwt_token_here
HOST=http://localhost:8080
```

Full variable reference:

| Variable | Required | Description |
|---|---|---|
| `HOST` | Yes | Deliveroo server URL |
| `TOKEN` | Single-agent only | JWT token for the agent |
| `TOKEN_COORDINATOR` | Two-agent mode | JWT for the coordinator |
| `TOKEN_WORKER` | Two-agent mode | JWT for the worker |
| `LITELLM_BASE_URL` | No | LiteLLM proxy URL — enables the LLM command layer |
| `LITELLM_API_KEY` | If LLM enabled | API key for the proxy |
| `LOCAL_MODEL` | No | Primary model (default: `gpt-4o`) |
| `LOCAL_MODEL_FALLBACK` | No | Fallback model on content-policy 400 (default: `llama-3.3-70b`) |
| `ADMIN_ID` | If LLM enabled | Chat sender id allowed to issue directives |
| `LOG_NAMESPACES` | No | Comma-separated log namespaces (`*` for all, empty for silent) |

## Running

### Single coordinator agent

```bash
npm start
# or equivalently:
node myAgent/coordinator_agent.js
```

Reads `TOKEN` and `HOST` from the environment. Runs with LLM layer enabled if `LITELLM_API_KEY` is set; otherwise runs BDI-only.

### Two-agent setup (coordinator + worker)

```bash
# Terminal 1
npm run start:coordinator

# Terminal 2
npm run start:worker
```

Both launch via [myAgent/launch.js](myAgent/launch.js), which sets the `AGENT_ROLE` env var before importing the coordinator agent module. The coordinator uses `TOKEN_COORDINATOR`; the worker uses `TOKEN_WORKER`. Both must be started before the game begins so the hello/hello_ack handshake completes.

The coordinator must have `LITELLM_API_KEY` set for the handoff mission to be available. The worker never needs it.

## Strategy selection

The agent picks its strategy automatically from the map configuration at startup. No configuration is needed in the common case. See [STRATEGIES.md](STRATEGIES.md) for the full selection logic.

## Architecture overview

See [architecture-overview.md](architecture-overview.md) for a module map and data flow description. Key entry points:

| File | Role |
|---|---|
| [myAgent/coordinator_agent.js](myAgent/coordinator_agent.js) | Bootstrap — wires BDI loop, strategy, LLM |
| [myAgent/launch.js](myAgent/launch.js) | Two-agent entry point |
| [myAgent/context.js](myAgent/context.js) | Shared singleton — all beliefs and config |
| [myAgent/strategies/selectStrategy.js](myAgent/strategies/selectStrategy.js) | Strategy auto-selection |
