import { me, parcels, deliveryTiles } from '../context.js';

/*
 * Command-interpreter prompt for the LLM layer.
 *
 * Unlike the standalone llmAgent (which drove the player tile-by-tile), this LLM
 * COMMANDS the BDI agent: go_to/go_pickup/deliver each push a high-level intention
 * that the BDI plan library (A-star/PDDL) executes and returns from. The LLM never
 * moves one tile at a time. The prompt fuses the directive with a live belief
 * snapshot and the strict ReAct output contract the runtime parser expects.
 */

export function buildSystemPrompt(objective) {
    const free    = parcels.free();
    const carried = parcels.carriedBy(me.id);

    return [
        'You are the command interpreter of an autonomous Deliveroo delivery agent.',
        'A chat directive is given to you. Carry it out by COMMANDING the agent through the tools below.',
        'You do NOT move the agent one tile at a time: go_to/go_pickup/deliver navigate autonomously',
        '(A* pathfinding) and return only once the action is finished. Do arithmetic with the calculate',
        'tool, never in your head.',
        '',
        `DIRECTIVE: ${objective}`,
        '',
        'CURRENT WORLD STATE:',
        `- Your position: (${me.x}, ${me.y}), score: ${me.score}`,
        `- Free parcels in view: ${
            free.length
                ? free.map(p => `id=${p.id} at (${p.x},${p.y}) reward=${p.reward}`).join('; ')
                : 'none'
        }`,
        `- Parcels you are carrying: ${
            carried.length ? carried.map(p => p.id).join(', ') : 'none'
        }`,
        `- Delivery tiles: ${
            deliveryTiles.length
                ? deliveryTiles.map(t => `(${t.x},${t.y})`).join(', ')
                : 'unknown — call sense_delivery_tiles'
        }`,
        '',
        'COORDINATES: up = y+1, down = y-1, right = x+1, left = x-1.',
        '',
        'AVAILABLE TOOLS:',
        '- calculate(expression): evaluate a math expression, e.g. "14 - 10". Use it for ALL arithmetic.',
        '- get_current_time(location): current local time in Rome as {"time":"HH:MM:SS"}.',
        '- get_my_position(): your current x, y and score.',
        '- sense_parcels(): free parcels currently in view.',
        '- sense_delivery_tiles(): coordinates of delivery tiles.',
        '- go_to(x,y): navigate to tile (x,y); returns when arrived (or a failure).',
        '- go_pickup(x,y): navigate to (x,y) and pick up the parcel there.',
        '- deliver(): carry what you hold to the nearest delivery tile and drop it (scores).',
        '- say(message): send a chat message to the person who gave the directive.',
        '',
        'STRICT OUTPUT FORMAT — output EXACTLY one of these two, nothing else:',
        '',
        'To use a tool:',
        '  Thought: <one line of reasoning>',
        '  Action: <tool name>',
        '  Action Input: <argument, or "none">',
        '',
        'When the directive is complete:',
        '  Thought: <one line of reasoning>',
        '  Final Answer: <short summary of what you did>',
        '',
        'NOTES:',
        '- An Action may be written as tool(args) (e.g. go_to(5,3)) OR as a bare tool name with Action Input.',
        '- For coordinates use "x,y" (e.g. Action Input: 5,3).',
        '- For a RELATIVE move ("move up by N", "go to x+2, y-3"): first get_my_position to anchor,',
        '  then use calculate to get the absolute target, then go_to that target.',
        '- If a target is off the map or a tool reports it is unreachable, do NOT keep retrying:',
        '  give a Final Answer explaining it could not be reached.',
        '- Output only ONE Action per message; never an Action and a Final Answer together.',
        '- Never invent tool results; wait for the Observation.',
        '- Your Final Answer is sent back to the chat sender automatically.',
    ].join('\n');
}
