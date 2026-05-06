import { GoPickUp }  from './GoPickUp.js';
import { GoDeliver }  from './GoDeliver.js';
import { GoExplore }  from './GoExplore.js';
import { PddlMove }   from './PddlMove.js';
import { AStarMove }  from './AStarMove.js';

/**
 * go_to resolution order:
 *   1. PddlMove  — optimal path via online PDDL solver
 *   2. AStarMove — local A* fallback if solver is unavailable
 */
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, AStarMove];
