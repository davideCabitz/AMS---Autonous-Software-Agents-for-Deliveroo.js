import { GoPickUp }  from './GoPickUp.js';
import { GoDeliver }  from './GoDeliver.js';
import { GoExplore }  from './GoExplore.js';
import { PddlMove }   from './PddlMove.js';
import { AStarMove }  from './AStarMove.js';


// PddlMove is checked first for go_to: if a crate genuinely blocks the route it
// plans the full macro-plan (push + navigate). If no crate blocks, isApplicableTo
// returns false instantly and AStarMove handles it with zero network cost.
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
