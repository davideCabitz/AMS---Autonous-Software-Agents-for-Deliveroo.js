import { GoPickUp }  from './GoPickUp.js';
import { GoDeliver }  from './GoDeliver.js';
import { GoExplore }  from './GoExplore.js';
import { PddlMove }   from './PddlMove.js';
import { AStarMove }  from './AStarMove.js';

/**
 * Plan library, in applicability-check order. PddlMove precedes AStarMove so
 * crate-planning triggers only when needed.
 * @type {Array<typeof PlanBase>}
 */
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
