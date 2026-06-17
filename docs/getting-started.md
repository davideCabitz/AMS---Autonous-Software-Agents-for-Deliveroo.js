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
HOST="http://localhost:8080"
```

Full variable reference (mirrors [`.env.example`](.env.example)):

| Variable | Required | Description |
|---|---|---|
| `HOST` | Yes | Deliveroo server URL |
| `TOKEN` | Single-agent only | JWT token for the agent |
| `TOKEN_COORDINATOR` | Two-agent mode | JWT for the coordinator |
| `TOKEN_WORKER` | Two-agent mode | JWT for the worker |
| `TOKEN_0`, `TOKEN_1`, … | Multi-agent mode | One distinct JWT per agent, indexed from 0 |
| `TOKENS` | Multi-agent mode | Alternative to `TOKEN_<i>`: comma-separated token list (`tok0,tok1,…`) |
| `AGENT_COUNT` | No | Default agent count for the multi-agent launcher (overridden by the CLI arg; default `5`) |
| `LITELLM_BASE_URL` | If LLM enabled | LiteLLM proxy URL — enables the LLM command layer |
| `LITELLM_API_KEY` | If LLM enabled | API key for the proxy |
| `LOCAL_MODEL` | No | Primary model (default: `gpt-4o`) |
| `LOCAL_MODEL_FALLBACK` | No | Fallback model on content-policy 400 (empty = none) |
| `EXPLORE_MODE` | No | `stochastic` for probabilistic group sampling; unset = deterministic exploration |
| `PDDL_GOTO` | No | `1` path-plans the "go to (x,y) for N points" mission via PDDL (else A*). See [PDDL.md](PDDL.md) |
| `PDDL_GATHER` | No | `1` lets PDDL select + path-plan the coordinator's tile in the `gather_near` mission (else A*). See [PDDL.md](PDDL.md) |
| `LOG_NAMESPACES` | No | Comma-separated log namespaces (`*` for all, empty for silent). See [Logger.md](Logger.md) |

> Both `PDDL_*` flags are off unless set to exactly `1`, and always fall back to A* on solver failure — so enabling them never breaks a mission.

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

### Multi-agent setup (N independent agents)

```bash
node multiple_run.js 5      # spawn 5 agents (count optional; defaults to AGENT_COUNT or 5)
```

[multiple_run.js](multiple_run.js) spawns `N` child processes, each running [myAgent/coordinator_agent.js](myAgent/coordinator_agent.js) with a distinct identity (`m_0`, `m_1`, …) and its own `TOKEN`. Each child's stdout/stderr is prefixed with its name so the interleaved logs stay readable.

The count is taken from the CLI argument, then `AGENT_COUNT`, then defaults to `5`. Each agent needs its own token, resolved per index in priority order:

1. `TOKEN_0`, `TOKEN_1`, … `TOKEN_<i>` (indexed, matching the `TOKEN_<ROLE>` style), then
2. `TOKENS="tok0,tok1,…"` (comma-separated list).

If no token is found for an agent, the child falls back to name-based auth (`NAME` only), which requires the server to allow nameless/auto-provisioned connections. These agents are **independent** — each runs its own BDI loop with no coordinator/worker handshake between them (that pairing is the two-agent mode above).

## Strategy selection

The agent picks its strategy automatically from the map configuration at startup. No configuration is needed in the common case. See [STRATEGIES.md](STRATEGIES.md) for the full selection logic.

## Architecture overview

See [architecture-overview.md](architecture-overview.md) for a module map and data flow description. Key entry points:

| File | Role |
|---|---|
| [myAgent/coordinator_agent.js](myAgent/coordinator_agent.js) | Bootstrap — wires BDI loop, strategy, LLM |
| [myAgent/launch.js](myAgent/launch.js) | Two-agent entry point (coordinator + worker) |
| [multiple_run.js](multiple_run.js) | Multi-agent entry point — spawns N independent agents |
| [myAgent/context.js](myAgent/context.js) | Shared singleton — all beliefs and config |
| [myAgent/strategies/selectStrategy.js](myAgent/strategies/selectStrategy.js) | Strategy auto-selection |
