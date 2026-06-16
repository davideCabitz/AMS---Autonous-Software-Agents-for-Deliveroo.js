/**
 * @class Parcels
 * Parcel belief state with optional memory for out-of-range parcels
 */
export class Parcels {
    /** @type {Map<string, Object>} Live parcel beliefs from sensing (id -> parcel) */
    #map = new Map();

    /** @type {Map<string, {id: string, x: number, y: number, reward: number, lastSeenMs: number}>} Remembered out-of-range parcels */
    #memory        = new Map();

    /** @type {boolean} Whether memory tracking is enabled */
    #memoryEnabled = false;

    /** @type {number} Decay interval in milliseconds */
    #decayIntervalMs = Infinity;

    /** @type {Set<string>} Permanently excluded parcel IDs (handed off to partner) */
    #ignored = new Set();

    /**
     * Enable parcel memory tracking with decay rate
     * @param {number} decayIntervalMs - Milliseconds per reward decay unit
     */
    enableMemory(decayIntervalMs) {
        this.#memoryEnabled  = true;
        this.#decayIntervalMs = decayIntervalMs;
    }

    /**
     * Sync beliefs with latest sensing, manage memory decay, protect carried parcels
     * @param {Array<Object>} sensingParcels - Current parcel observations from server
     * @param {string|null} selfId - Agent ID (protects self-carried parcels from eviction)
     */
    sync(sensingParcels, selfId = null) {
        const now = Date.now();

        // 1. Sweep memory: evict entries whose reward has fully decayed.
        if (this.#memoryEnabled && Number.isFinite(this.#decayIntervalMs)) {
            for (const [id, mp] of this.#memory) {
                const decayed = Math.floor((now - mp.lastSeenMs) / this.#decayIntervalMs);
                if (mp.reward - decayed <= 0) this.#memory.delete(id);
            }
        }

        // 2. Update live map from sensing; sensing is authoritative over memory.
        for (const p of sensingParcels) {
            if (this.#ignored.has(p.id)) continue;   // handed off to the partner — never re-acquire
            this.#map.set(p.id, p);
            if (this.#memoryEnabled) this.#memory.delete(p.id);
        }

        // 3. Evict from live map parcels no longer in sensing (and not self-carried);
        //    free ones are moved into memory when memory is enabled.
        for (const id of this.#map.keys()) {
            const known = this.#map.get(id);
            if (!sensingParcels.find(sp => sp.id === id) && !(selfId && known.carriedBy === selfId)) {
                if (this.#memoryEnabled && known && !known.carriedBy) {
                    this.#memory.set(id, { id: known.id, x: known.x, y: known.y, reward: known.reward, lastSeenMs: now });
                }
                this.#map.delete(id);
            }
        }
    }

    /**
     * Mark parcel as carried by an agent
     * @param {string} id - Parcel ID
     * @param {string} agentId - Agent ID carrying the parcel
     */
    setCarriedBy(id, agentId) {
        const p = this.#map.get(id);
        if (p) p.carriedBy = agentId;
    }

    /**
     * Remove parcel from all beliefs (sensing + memory)
     * @param {string} id - Parcel ID
     */
    remove(id) {
        this.#map.delete(id);
        this.#memory.delete(id); // also evict from memory on failed pickup / explicit removal
    }

    /**
     * Permanently exclude parcel from beliefs and future syncs (handed to partner)
     * @param {string} id - Parcel ID to ignore
     */
    ignore(id) {
        this.#ignored.add(id);
        this.#map.delete(id);
        this.#memory.delete(id);
    }

    /**
     * Get all parcels in current beliefs
     * @returns {Array<Object>} All live parcels
     */
    all() {
        return [...this.#map.values()];
    }

    /**
     * Get free (uncarried, not ignored) parcels
     * @returns {Array<Object>} Free parcels available for pickup
     */
    free() {
        return this.all().filter(p => !p.carriedBy && !this.#ignored.has(p.id));
    }

    /**
     * Get parcels carried by a specific agent
     * @param {string} agentId - Agent ID
     * @returns {Array<Object>} Parcels carried by this agent
     */
    carriedBy(agentId) {
        return this.all().filter(p => p.carriedBy === agentId);
    }

    /**
     * Get a specific parcel by ID
     * @param {string} id - Parcel ID
     * @returns {Object|undefined} Parcel object or undefined
     */
    get(id) {
        return this.#map.get(id);
    }

    /** @type {number} Total number of live parcels */
    get size() {
        return this.#map.size;
    }

    // ─── memory read API (consumed only by StrategyMemory) ───────────────────

    /**
     * Get remembered (out-of-range) parcels with decay applied
     * @returns {Array<Object>} Parcels with currentReward > 0 (empty array if memory disabled)
     */
    remembered() {
        if (!this.#memoryEnabled) return [];
        const now = Date.now();
        const result = [];
        for (const [id, mp] of this.#memory) {
            if (this.#map.has(id)) continue; // live sensing is authoritative
            if (this.#ignored.has(id)) continue; // handed off to the partner
            const decayed = Number.isFinite(this.#decayIntervalMs)
                ? Math.floor((now - mp.lastSeenMs) / this.#decayIntervalMs)
                : 0;
            const currentReward = mp.reward - decayed;
            if (currentReward > 0) result.push({ ...mp, reward: currentReward });
        }
        return result;
    }

    /**
     * Get raw memory entry without decay (for validity checks)
     * @param {string} id - Parcel ID
     * @returns {Object|null} Raw memory entry or null if memory disabled/unknown
     */
    getRemembered(id) {
        return this.#memoryEnabled ? (this.#memory.get(id) ?? null) : null;
    }
}
