import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ready, me } from './context.js';
import { executeObjective } from './executor.js';

/*
 * Entry point for the standalone LLM agent.
 *
 * Run with:  node llmAgent/llmAgent.js
 *            node llmAgent/llmAgent.js "pick up the nearest parcel and deliver it"
 *
 * Connects its own socket (HOST/TOKEN/NAME from .env), waits to be authenticated,
 * then either runs a single objective passed on the command line, or opens an
 * interactive prompt. Run this INSTEAD of the BDI agent (same token).
 */

async function main() {
    console.log('Waiting for server authentication...');
    await ready;
    console.log(`Connected as ${me.name} (${me.id}) at (${me.x}, ${me.y}).`);

    // Give the first sensing/map events a moment to populate beliefs.
    await new Promise(r => setTimeout(r, 500));

    const cliObjective = process.argv.slice(2).join(' ').trim();
    if (cliObjective) {
        const result = await executeObjective(cliObjective);
        console.log('\n=== DONE ===\n' + result);
        process.exit(0);
    }

    const rl = readline.createInterface({ input, output });
    console.log('\nLLM agent ready. Type a natural-language objective.');
    console.log('Examples: "go pick up the nearest parcel", "deliver everything you carry".');
    console.log('Commands: /exit to quit.\n');

    while (true) {
        const objective = (await rl.question('Objective: ')).trim();
        if (objective === '/exit' || objective === 'exit') break;
        if (!objective) continue;

        try {
            const result = await executeObjective(objective);
            console.log('\n=== DONE ===\n' + result + '\n');
        } catch (err) {
            console.error('[error]', err?.message ?? err);
        }
    }

    rl.close();
    console.log('Bye.');
    process.exit(0);
}

main().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
});
