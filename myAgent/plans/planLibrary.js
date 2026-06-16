import { GoPickUp }  from './GoPickUp.js';
import { GoDeliver }  from './GoDeliver.js';
import { GoExplore }  from './GoExplore.js';
import { PddlMove }   from './PddlMove.js';
import { AStarMove }  from './AStarMove.js';

/**
 * Plan library ordered by applicability checking
 * PddlMove is checked before AStarMove: crate-planning only triggers when needed
 * @type {Array<typeof PlanBase>}
 */
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
