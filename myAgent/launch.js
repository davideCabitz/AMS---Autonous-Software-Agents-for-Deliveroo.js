import 'dotenv/config';

/*
 * Two-agent launcher: runs the SAME agent code twice with different roles.
 *   coordinator — full BDI + LLM command layer; commands itself and the worker
 *                 (token TOKEN_COORDINATOR).
 *   worker      — plain BDI + partner-order handler (token TOKEN_WORKER).
 *
 * TOKEN must be set BEFORE coordinator_agent.js loads: context.js calls DjsConnect()
 * at module load, reading process.env.TOKEN then. dotenv is loaded here first so the
 * role tokens exist (context.js's own dotenv import is then a no-op).
 *
 * Usage: node myAgent/launch.js coordinator|worker
 */

const role = (process.argv[2] ?? 'coordinator').toLowerCase();
if (!['coordinator', 'worker'].includes(role)) {
    console.error(`Unknown role '${role}'. Usage: node myAgent/launch.js coordinator|worker`);
    process.exit(1);
}

const token = role === 'coordinator' ? process.env.TOKEN_COORDINATOR : process.env.TOKEN_WORKER;
if (!token) {
    console.error(`Missing ${role === 'coordinator' ? 'TOKEN_COORDINATOR' : 'TOKEN_WORKER'} in .env`);
    process.exit(1);
}

process.env.AGENT_ROLE = role;
process.env.TOKEN      = token;

await import('./coordinator_agent.js');
