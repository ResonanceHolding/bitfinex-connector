'use strict';

const { Debug } = require('./logger.js');

const LOCKED = 0n;
const UNLOCKED = 1n;

class Mutex {
  #owner = false;
  constructor(shared, offset = 0, init = false) {
    this.lock = new BigInt64Array(shared, offset, 1);
    if (init) Atomics.store(this.lock, 0, UNLOCKED);
  }

  enter() {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const lastState = Atomics.compareExchange(
          this.lock,
          0,
          UNLOCKED,
          LOCKED
        );
        if (lastState === UNLOCKED) {
          this.#owner = true;
          clearInterval(interval);
          Debug('mutex enter');
          resolve();
        }
      }, 10);
    });
  }

  leave() {
    if(!this.#owner) {
      Debug('Can`t mutex leave. Your are not owner!');
      return false;
    }
    Atomics.store(this.lock, 0, UNLOCKED);
    Debug('mutex leave');
    return true;
  }
}

module.exports = Mutex;
