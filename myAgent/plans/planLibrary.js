import { GoPickUp } from './GoPickUp.js';
import { GoDeliver } from './GoDeliver.js';
import { BlindMove } from './BlindMove.js';

/**
 * Ordered list of plan classes. IntentionDeliberation iterates this list and
 * picks the first plan whose isApplicableTo() returns true.
 *
 * To add A* movement: insert AStarMove before BlindMove — same interface,
 * smarter execution. BlindMove acts as a safe fallback.
 */
export const planLibrary = [GoPickUp, GoDeliver, BlindMove];
