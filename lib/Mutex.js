'use strict';

const { Debug } = require('./logger.js');

const LOCKED = 0n;
const UNLOCKED = 1n;

class Mutex {
  #owner = false;
  constructor({ shared, name, offset = 0, init = false }) {
    if (!shared)
      throw new Error(
        'For the mutex to work correctly, you need to define shared memory!'
      );
    this.name = name;
    this.lock = new BigInt64Array(shared, offset, 1);
    if (init) Atomics.store(this.lock, 0, UNLOCKED);
  }

  enter() {
    return new Promise((resolve) => {
      const { name } = this;
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
          if (name) Debug(`mutex ${name} enter`);
          resolve();
        }
      }, 10);
    });
  }

  leave() {
    const { name } = this;
    if (!this.#owner) {
      if (name) Debug(`You can't leave mutex ${name}: you aren't the owner!`);
      return false;
    }
    Atomics.store(this.lock, 0, UNLOCKED);
    if (name) Debug(`mutex ${name} leave`);
    return true;
  }
}

module.exports = Mutex;
