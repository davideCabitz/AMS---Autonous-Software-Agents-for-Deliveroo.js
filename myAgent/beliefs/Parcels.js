/**
 * @class Parcels
 * Parcel beliefs, with optional memory for out-of-range parcels.
 */
export class Parcels {
    /** @type {Map<string, Object>} Live beliefs from sensing (id → parcel) */
    #map = new Map();

    /** @type {Map<string, {id: string, x: number, y: number, reward: number, lastSeenMs: number}>} Remembered out-of-range parcels */
    #memory        = new Map();

    /** @type {boolean} Whether memory tracking is on */
    #memoryEnabled = false;

    /** @type {number} Decay interval (ms) */
    #decayIntervalMs = Infinity;

    /** @type {Set<string>} Permanently excluded IDs (handed to partner) */
    #ignored = new Set();

    /**
     * Enable memory tracking with a decay rate
     * @param {number} decayIntervalMs - Milliseconds per reward decay unit
     */
    enableMemory(decayIntervalMs) {
        this.#memoryEnabled  = true;
        this.#decayIntervalMs = decayIntervalMs;
    }

    /**
     * Sync beliefs with sensing: decay memory, protect self-carried parcels
     * @param {Array<Object>} sensingParcels - Current observations from server
     * @param {string|null} selfId - Agent ID (protects its carried parcels from eviction)
     */
    sync(sensingParcels, selfId = null) {
        const now = Date.now();

        // 1. Evict memory entries whose reward has fully decayed.
        if (this.#memoryEnabled && Number.isFinite(this.#decayIntervalMs)) {
            for (const [id, mp] of this.#memory) {
                const decayed = Math.floor((now - mp.lastSeenMs) / this.#decayIntervalMs);
                if (mp.reward - decayed <= 0) this.#memory.delete(id);
            }
        }

        // 2. Update live map from sensing (authoritative over memory).
        for (const p of sensingParcels) {
            if (this.#ignored.has(p.id)) continue;   // handed off — never re-acquire
            this.#map.set(p.id, p);
            if (this.#memoryEnabled) this.#memory.delete(p.id);
        }

        // 3. Drop live parcels gone from sensing (unless self-carried); free ones
        //    move into memory when enabled.
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
     * Mark a parcel as carried by an agent
     * @param {string} id - Parcel ID
     * @param {string} agentId - Carrier agent ID
     */
    setCarriedBy(id, agentId) {
        const p = this.#map.get(id);
        if (p) p.carriedBy = agentId;
    }

    /**
     * Remove a parcel from all beliefs (sensing + memory)
     * @param {string} id - Parcel ID
     */
    remove(id) {
        this.#map.delete(id);
        this.#memory.delete(id); // also evict on failed pickup / explicit removal
    }

    /**
     * Permanently exclude a parcel from beliefs and future syncs (handed to partner)
     * @param {string} id - Parcel ID to ignore
     */
    ignore(id) {
        this.#ignored.add(id);
        this.#map.delete(id);
        this.#memory.delete(id);
    }

    /**
     * @returns {Array<Object>} All live parcels
     */
    all() {
        return [...this.#map.values()];
    }

    /**
     * @returns {Array<Object>} Free (uncarried, not ignored) parcels available for pickup
     */
    free() {
        return this.all().filter(p => !p.carriedBy && !this.#ignored.has(p.id));
    }

    /**
     * @param {string} agentId - Agent ID
     * @returns {Array<Object>} Parcels carried by this agent
     */
    carriedBy(agentId) {
        return this.all().filter(p => p.carriedBy === agentId);
    }

    /**
     * @param {string} id - Parcel ID
     * @returns {Object|undefined} Parcel, or undefined if unknown
     */
    get(id) {
        return this.#map.get(id);
    }

    /** @type {number} Live parcel count */
    get size() {
        return this.#map.size;
    }

    // ─── memory read API (consumed only by StrategyMemory) ───────────────────

    /**
     * @returns {Array<Object>} Remembered parcels with decay applied (currentReward > 0; empty if memory off)
     */
    remembered() {
        if (!this.#memoryEnabled) return [];
        const now = Date.now();
        const result = [];
        for (const [id, mp] of this.#memory) {
            if (this.#map.has(id)) continue; // live sensing wins
            if (this.#ignored.has(id)) continue; // handed off
            const decayed = Number.isFinite(this.#decayIntervalMs)
                ? Math.floor((now - mp.lastSeenMs) / this.#decayIntervalMs)
                : 0;
            const currentReward = mp.reward - decayed;
            if (currentReward > 0) result.push({ ...mp, reward: currentReward });
        }
        return result;
    }

    /**
     * Raw memory entry without decay (for validity checks)
     * @param {string} id - Parcel ID
     * @returns {Object|null} Raw entry, or null if memory off/unknown
     */
    getRemembered(id) {
        return this.#memoryEnabled ? (this.#memory.get(id) ?? null) : null;
    }
}
