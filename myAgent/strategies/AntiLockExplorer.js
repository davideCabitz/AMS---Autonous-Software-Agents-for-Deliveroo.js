import { me } from '../context.js';

// Re-evaluate the explore target at least this often, even while committed.
export const EXPLORE_COMMIT_MS    = 4000;
// If the agent's tile hasn't changed for this long it's stuck (blocked / bounced) → give up the target.
export const EXPLORE_STALL_MS     = 1500;
// How long a given-up target stays excluded before it can be chosen again.
export const EXPLORE_BLACKLIST_MS = 5000;

/**
 * @class AntiLockExplorer
 * Composition helper holding the commit / stall / blacklist machinery shared by
 * StrategyBlind and StrategyHurry. It owns ONLY the mechanical anti-lock state
 * (commit key/time, last-position stall clock, blacklist map). Each host keeps its
 * own distinct target selection and success-exit policy (Blind: reached-on-tile +
 * always blacklist on exit; Hurry: observed-via-sensing + blacklist only on
 * stall/timeout) — the helper deliberately does not know about those so neither
 * strategy's behaviour changes.
 */
export class AntiLockExplorer {
    /** @type {string|null} "x_y" key of current explore target */
    #commitKey   = null;
    /** @type {number} Timestamp when committed to current target */
    #commitSince = 0;
    /** @type {{x: number, y: number}|null} Last observed agent position */
    #lastPos     = null;
    /** @type {number} Timestamp when agent position last changed */
    #lastMoved   = 0;
    /** @type {Map<string, number>} Blacklisted tiles with expiry timestamps */
    #blacklist   = new Map();

    /** @type {(msg: string) => void} */
    #log;

    /** @param {(msg: string) => void} log - Host logger so log namespaces are preserved */
    constructor(log = () => {}) { this.#log = log; }

    /**
     * Track physical movement (drives the stall detector). Resets the stall clock
     * whenever the agent's rounded tile changes.
     * @param {number} now - Date.now()
     */
    trackMovement(now) {
        const px = Math.round(me.x), py = Math.round(me.y);
        if (!this.#lastPos || this.#lastPos.x !== px || this.#lastPos.y !== py) {
            this.#lastPos   = { x: px, y: py };
            this.#lastMoved = now;
        }
    }

    /**
     * Drop expired blacklist entries.
     * @param {number} now - Date.now()
     */
    expireBlacklist(now) {
        for (const [k, exp] of this.#blacklist) if (exp <= now) this.#blacklist.delete(k);
    }

    /** @param {string} key @returns {boolean} */
    isBlacklisted(key) { return this.#blacklist.has(key); }

    /** Blacklist a tile for EXPLORE_BLACKLIST_MS. @param {string} key @param {number} now */
    blacklist(key, now) { this.#blacklist.set(key, now + EXPLORE_BLACKLIST_MS); }

    /**
     * Re-arm the commit clock if the target changed, then report stall/timeout.
     * The caller decides what to do with the result (and tests its own success
     * exit — reached/observed — separately).
     * @param {string} key - "x_y" of the in-flight target
     * @param {number} now - Date.now()
     * @returns {{stalled: boolean, timedOut: boolean}}
     */
    commitStatus(key, now) {
        if (this.#commitKey !== key) { this.#commitKey = key; this.#commitSince = now; }
        return {
            stalled:  now - this.#lastMoved   >= EXPLORE_STALL_MS,
            timedOut: now - this.#commitSince >= EXPLORE_COMMIT_MS,
        };
    }

    /** Common give-up tail: log, blacklist, clear commit. @param {string} key @param {number} now @param {boolean} stalled */
    giveUp(key, now, stalled) {
        this.#log(`giving up target ${key} (${stalled ? 'stalled' : 'timeout'}) — re-selecting`);
        this.blacklist(key, now);
        this.#commitKey = null;
    }

    /** Clear the current commitment (used on grab/deliver/reached resets). */
    clearCommit() { this.#commitKey = null; }

    /** Record commitment to a freshly-selected target. @param {string} key @param {number} now */
    commitTo(key, now) { this.#commitKey = key; this.#commitSince = now; }
}
