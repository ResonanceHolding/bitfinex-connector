'use strict';

const { Debug } = require('./logger.js');

const LOCKED = 0n;
const UNLOCKED = 1n;

class Mutex {
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
          clearInterval(interval);
          Debug('mutex enter');
          resolve();
        }
      }, 10);
    });
  }

  leave() {
    Atomics.store(this.lock, 0, UNLOCKED);
    Debug('mutex leave');
  }
}

module.exports = Mutex;
