/**
 * Shared anti-lock exploration bookkeeping for the sensing-poor strategies
 * (StrategyBlind, StrategyHurry): commit to a target, detect when the agent is
 * stuck or has spent too long on one, and blacklist abandoned targets briefly so
 * exploration fans out instead of ping-ponging between the two closest spawners.
 *
 * Owns ONLY this shared state (movement tracking, commit, stall/timeout, blacklist);
 * each strategy keeps its own target-selection logic and drives these primitives.
 */

// Tile unchanged for this long ⇒ stuck → give up the target.
export const EXPLORE_STALL_MS     = 1500;
// Re-evaluate / cap a single target at least this often, even while committed.
export const EXPLORE_COMMIT_MS    = 4000;
// How long a given-up target stays excluded before it can be re-chosen.
export const EXPLORE_BLACKLIST_MS = 5000;

export class AntiLockExplorer {
    /** @type {string|null} "x_y" key of the current explore target */
    #commitKey   = null;
    /** @type {number} Timestamp when committed to the current target */
    #commitSince = 0;
    /** @type {{x: number, y: number}|null} Last observed agent tile */
    #lastPos     = null;
    /** @type {number} Timestamp when the agent tile last changed */
    #lastMoved   = 0;
    /** @type {Map<string, number>} "x_y" → expiry timestamp for stuck/unreachable targets */
    #blacklist   = new Map();

    /**
     * Record the agent's current tile (resets the stall clock on any change)
     * @param {number} px - Rounded agent x
     * @param {number} py - Rounded agent y
     * @param {number} now - Current timestamp (ms)
     * @returns {void}
     */
    trackMovement(px, py, now) {
        if (!this.#lastPos || this.#lastPos.x !== px || this.#lastPos.y !== py) {
            this.#lastPos   = { x: px, y: py };
            this.#lastMoved = now;
        }
    }

    /**
     * Commit to a target, restarting its commit clock only when the key changes
     * @param {string} key - "x_y" target key
     * @param {number} now - Current timestamp (ms)
     * @returns {void}
     */
    commitTo(key, now) {
        if (this.#commitKey !== key) {
            this.#commitKey   = key;
            this.#commitSince = now;
        }
    }

    /**
     * Commit to a freshly selected target, ALWAYS restarting the commit clock
     * (even if the key is unchanged)
     * @param {string} key - "x_y" target key
     * @param {number} now - Current timestamp (ms)
     * @returns {void}
     */
    recommit(key, now) {
        this.#commitKey   = key;
        this.#commitSince = now;
    }

    /** Clear the current commitment. @returns {void} */
    clearCommit() { this.#commitKey = null; }

    /**
     * Has the agent failed to move for at least EXPLORE_STALL_MS (blocked/bounced)?
     * @param {number} now - Current timestamp (ms)
     * @returns {boolean}
     */
    stalled(now) { return now - this.#lastMoved >= EXPLORE_STALL_MS; }

    /**
     * Has the current target been committed for at least EXPLORE_COMMIT_MS?
     * @param {number} now - Current timestamp (ms)
     * @returns {boolean}
     */
    timedOut(now) { return now - this.#commitSince >= EXPLORE_COMMIT_MS; }

    /**
     * Drop expired blacklist entries.
     * @param {number} now - Current timestamp (ms)
     * @returns {void}
     */
    pruneBlacklist(now) {
        for (const [k, exp] of this.#blacklist) if (exp <= now) this.#blacklist.delete(k);
    }

    /**
     * Blacklist a target key for EXPLORE_BLACKLIST_MS from `now`.
     * @param {string} key - "x_y" target key
     * @param {number} now - Current timestamp (ms)
     * @returns {void}
     */
    blacklist(key, now) { this.#blacklist.set(key, now + EXPLORE_BLACKLIST_MS); }

    /**
     * Is `key` currently blacklisted?
     * @param {string} key - "x_y" target key
     * @returns {boolean}
     */
    isBlacklisted(key) { return this.#blacklist.has(key); }
}
