import { spawn }  from 'child_process';
import { config }  from 'dotenv';
config();

const HOST  = process.env.HOST  || '';
const TOKEN = process.env.TOKEN || '';

for (let i = 0; i < 5; i++) {
    const name  = `m_${i}`;
    const child = spawn(
        `HOST="${HOST}" TOKEN="${TOKEN}" NAME="${name}" node myAgent/agent.js`,
        { shell: true }
    );
    child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${name}] ERR: ${d}`));
    child.on('close', code => console.log(`[${name}] exit: ${code}`));
}
