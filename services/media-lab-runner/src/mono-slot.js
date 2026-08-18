'use strict';

class MonoSlotCoordinator {
    #active = false;
    #generation = 0;

    get busy() {
        return this.#active;
    }

    tryAcquire() {
        if (this.#active) return null;
        this.#active = true;
        const generation = ++this.#generation;
        let released = false;
        return Object.freeze({
            release: () => {
                if (released) return false;
                released = true;
                if (this.#active && this.#generation === generation) {
                    this.#active = false;
                    return true;
                }
                return false;
            },
        });
    }
}

module.exports = Object.freeze({ MonoSlotCoordinator });
