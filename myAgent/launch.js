import 'dotenv/config';

/*
 * Two-agent launcher. The challenge-2 system runs the SAME agent code twice with
 * different roles:
 *   coordinator — full BDI + LLM command layer; interprets shouted missions and
<<<<<<< HEAD
 *                 commands both itself and the worker (token TOKEN_LLM).
 *   worker      — plain BDI + lightweight partner-order handler (token TOKEN_BDI).
=======
 *                 commands both itself and the worker (token TOKEN_COORDINATOR).
 *   worker      — plain BDI + lightweight partner-order handler (token TOKEN_WORKER).
>>>>>>> 16ed51407381be43e7cf80feaba7740c0567e412
 *
 * TOKEN must be set BEFORE agent.js is imported: context.js calls DjsConnect()
 * at module load, and DjsConnect reads process.env.TOKEN at call time. dotenv is
 * loaded here first so the role tokens are available; context.js's own
 * `import 'dotenv/config'` is then a no-op (dotenv never overrides existing vars).
 *
 * Usage: node myAgent/launch.js coordinator|worker
 */

const role = (process.argv[2] ?? 'coordinator').toLowerCase();
if (!['coordinator', 'worker'].includes(role)) {
    console.error(`Unknown role '${role}'. Usage: node myAgent/launch.js coordinator|worker`);
    process.exit(1);
}

<<<<<<< HEAD
const token = role === 'coordinator' ? process.env.TOKEN_LLM : process.env.TOKEN_BDI;
if (!token) {
    console.error(`Missing ${role === 'coordinator' ? 'TOKEN_LLM' : 'TOKEN_BDI'} in .env`);
=======
const token = role === 'coordinator' ? process.env.TOKEN_COORDINATOR : process.env.TOKEN_WORKER;
if (!token) {
    console.error(`Missing ${role === 'coordinator' ? 'TOKEN_COORDINATOR' : 'TOKEN_WORKER'} in .env`);
>>>>>>> 16ed51407381be43e7cf80feaba7740c0567e412
    process.exit(1);
}

process.env.AGENT_ROLE = role;
process.env.TOKEN      = token;

await import('./agent.js');
