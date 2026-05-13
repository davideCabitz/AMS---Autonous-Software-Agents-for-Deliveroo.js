export class Parcels {
    /** @type {Map<string, Parcel>} */
    #map = new Map();


    sync(sensingParcels) {
        for (const p of sensingParcels) {
            this.#map.set(p.id, p);
        }
        for (const id of this.#map.keys()) {
            if (!sensingParcels.find(sp => sp.id === id)) {
                this.#map.delete(id);
            }
        }
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
