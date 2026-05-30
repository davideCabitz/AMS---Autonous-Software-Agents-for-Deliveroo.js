export class Parcels {
    /** @type {Map<string, Parcel>} */
    #map = new Map();


    /**
     * Reconcile beliefs with the latest sensing. `selfId` (the agent's own id)
     * protects parcels we know we're carrying: blind maps stop reporting a parcel
     * once it's on our tile/carried, and without this guard the next sync would
     * wipe the carried belief and break delivery mid-trip.
     */
    sync(sensingParcels, selfId = null) {
        for (const p of sensingParcels) {
            this.#map.set(p.id, p);
        }
        for (const id of this.#map.keys()) {
            const known = this.#map.get(id);
            if (!sensingParcels.find(sp => sp.id === id) && !(selfId && known.carriedBy === selfId)) {
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
}
