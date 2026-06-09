export class Parcels {
    /** @type {Map<string, Parcel>} */
    #map = new Map();

    // ─── parcel memory (StrategyMemory only) ─────────────────────────────────
    // id → { id, x, y, reward, lastSeenMs }
    #memory        = new Map();
    #memoryEnabled = false;
    #decayIntervalMs = Infinity;

    /**
     * Activate parcel memory. Called once from selectStrategy() when StrategyMemory
     * is chosen. When disabled (default) the #memory Map is never written to, so
     * all existing strategies remain completely unaffected.
     */
    enableMemory(decayIntervalMs) {
        this.#memoryEnabled  = true;
        this.#decayIntervalMs = decayIntervalMs;
    }

    /**
     * Reconcile beliefs with the latest sensing. `selfId` (the agent's own id)
     * protects parcels we know we're carrying: blind maps stop reporting a parcel
     * once it's on our tile/carried, and without this guard the next sync would
     * wipe the carried belief and break delivery mid-trip.
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

    /** Mark a parcel as carried by an agent (used to apply pickup results to beliefs). */
    setCarriedBy(id, agentId) {
        const p = this.#map.get(id);
        if (p) p.carriedBy = agentId;
    }

    /** Drop a parcel from beliefs (used to apply pickup/putdown results). */
    remove(id) {
        this.#map.delete(id);
        this.#memory.delete(id); // also evict from memory on failed pickup / explicit removal
    }

    /** All parcels currently in belief state. */
    all() {
        return [...this.#map.values()];
    }

    /*Free parcels */
    free() {
        return this.all().filter(p => !p.carriedBy);
    }

    /** Parcels currently carried by a given agent id. */
    carriedBy(agentId) {
        return this.all().filter(p => p.carriedBy === agentId);
    }

    get(id) {
        return this.#map.get(id);
    }

    get size() {
        return this.#map.size;
    }

    // ─── memory read API (consumed only by StrategyMemory) ───────────────────

    /**
     * Returns snapshots of remembered (out-of-range) parcels with their current
     * decayed reward. Parcels with reward ≤ 0 are excluded. Returns [] when
     * memory is disabled — all existing strategies are completely unaffected.
     */
    remembered() {
        if (!this.#memoryEnabled) return [];
        const now = Date.now();
        const result = [];
        for (const [id, mp] of this.#memory) {
            if (this.#map.has(id)) continue; // live sensing is authoritative
            const decayed = Number.isFinite(this.#decayIntervalMs)
                ? Math.floor((now - mp.lastSeenMs) / this.#decayIntervalMs)
                : 0;
            const currentReward = mp.reward - decayed;
            if (currentReward > 0) result.push({ ...mp, reward: currentReward });
        }
        return result;
    }

    /**
     * Raw memory entry for a single id (no decay applied). Used only by the
     * intention validity check to confirm a remembered parcel still exists.
     * Returns null when memory is disabled or the id is unknown.
     */
    getRemembered(id) {
        return this.#memoryEnabled ? (this.#memory.get(id) ?? null) : null;
    }
}
