import { GoPickUp }  from './GoPickUp.js';
import { GoDeliver }  from './GoDeliver.js';
import { GoExplore }  from './GoExplore.js';
import { PddlMove }   from './PddlMove.js';
import { AStarMove }  from './AStarMove.js';


// PddlMove takes priority for go_to, but only applies when crates are present
// (see PddlMove.isApplicableTo). Otherwise it falls through to AStarMove, which
// also serves as fallback if the online solver fails.
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
