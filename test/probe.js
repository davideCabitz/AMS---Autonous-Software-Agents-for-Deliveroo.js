import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/*
 * Test driver for the two-agent LLM system. Connects as a THIRD client by name
 * (no token — the server auto-registers it), so it can play the mission agent's
 * role without the admin token: shout mission prompts, message the coordinator
 * directly, and print every reply it receives.
 *
 * Usage:
 *   node test/probe.js shout "<mission prompt>"            broadcast like a mission agent
 *   node test/probe.js say <agentId> "<message>"           direct chat to one agent
 *   node test/probe.js listen                               just connect and print messages
 * Options (after the message):
 *   --wait <seconds>   how long to keep listening for replies (default 45)
 *
 * It cannot emit rewards (admin only) — score changes still need the real
 * mission agents from lab/missionAgents.
 */

const [, , mode, ...rest] = process.argv;

let waitSecs = 45;
const wi = rest.indexOf('--wait');
if (wi !== -1) { waitSecs = parseFloat(rest[wi + 1]) || waitSecs; rest.splice(wi, 2); }

if (!['shout', 'say', 'listen'].includes(mode)) {
    console.error('Usage: node test/probe.js shout "<text>" | say <agentId> "<text>" | listen  [--wait N]');
    process.exit(1);
}

const socket = DjsConnect(process.env.HOST, '', 'probe');

socket.onMsg((id, name, msg) => {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    console.log(`[recv] from ${name ?? '?'} (${id}): ${text}`);
});

socket.onYou(me => {
    if (!socket.__announced) {
        socket.__announced = true;
        console.log(`[probe] connected as ${me.name} (${me.id}) at (${me.x},${me.y})`);
    }
});

setTimeout(async () => {
    try {
        if (mode === 'shout') {
            const text = rest.join(' ');
            console.log(`[probe] SHOUT: ${text}`);
            await socket.emitShout(text);
        } else if (mode === 'say') {
            const [target, ...words] = rest;
            const text = words.join(' ');
            console.log(`[probe] SAY -> ${target}: ${text}`);
            await socket.emitSay(target, text);
        } else {
            console.log('[probe] listening only');
        }
    } catch (err) {
        console.error('[probe] send failed:', err?.message ?? err);
    }
    console.log(`[probe] listening for replies for ${waitSecs}s ...`);
    setTimeout(() => process.exit(0), waitSecs * 1000);
}, 2000);
