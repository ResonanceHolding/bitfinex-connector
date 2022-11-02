'use strict';

const LOCKED = 0n;
const UNLOCKED = 1n;

class Mutex {
  constructor(shared, offset = 0, init = false) {
    this.lock = new BigInt64Array(shared, offset, 1);
    if (init) Atomics.store(this.lock, 0, UNLOCKED);
  }

  enter() {
    return new Promise((resolve) => {
      while (1) {
        Atomics.wait(this.lock, 0, LOCKED);
        const lastState = Atomics.compareExchange(
          this.lock,
          0,
          UNLOCKED,
          LOCKED
        );
        if (lastState === UNLOCKED) {
          resolve();
          break;
        }
      }
    });
  }

  leave() {
    Atomics.store(this.lock, 0, UNLOCKED);
    Atomics.notify(this.lock, 0, 1);
  }
}

module.exports = Mutex;
