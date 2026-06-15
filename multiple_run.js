import { spawn }  from 'child_process';
import { config }  from 'dotenv';
config();

const HOST  = process.env.HOST  || '';
const COUNT = parseInt(process.argv[2] || process.env.AGENT_COUNT || '5', 10);

// The SDK (DjsConnect.js) authenticates by TOKEN when set and ignores NAME;
// a single shared TOKEN would make every child the SAME agent. This project
// uses per-identity JWTs (see .env.example: TOKEN, TOKEN_COORDINATOR, TOKEN_WORKER).
//
// Provide one distinct token per agent, in priority order:
//   1. TOKEN_0, TOKEN_1, ... TOKEN_<n>   (indexed, matches the TOKEN_<ROLE> style)
//   2. TOKENS="tok0,tok1,..."            (comma-separated list)
// If no token is available for an agent, fall back to name-based auth (NAME only),
// which requires the server to allow nameless/auto-provisioned connections.
const TOKENS = (process.env.TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);

function tokenFor(i) {
    return process.env[`TOKEN_${i}`] || TOKENS[i] || '';
}

for (let i = 0; i < COUNT; i++) {
    const name  = `m_${i}`;
<<<<<<< HEAD
    const token = tokenFor(i);
    const env   = { ...process.env, HOST, NAME: name };
    if (token) env.TOKEN = token;
    else delete env.TOKEN;   // avoid an inherited shared TOKEN overriding NAME

    const child = spawn('node', ['myAgent/agent.js'], { env, stdio: 'pipe' });
=======
    const child = spawn(
        `HOST="${HOST}" TOKEN="${TOKEN}" NAME="${name}" node myAgent/coordinator_agent.js`,
        { shell: true }
    );
>>>>>>> LLM
    child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${name}] ERR: ${d}`));
    child.on('close', code => console.log(`[${name}] exit: ${code}`));
}
