'use strict';

const { Debug } = require('./logger.js');

const LOCKED = 0n;
const UNLOCKED = 1n;

class Semaphore {
  constructor() {
    const buffer = new ArrayBuffer(8);
    this.lock = new BigInt64Array(buffer, offset, 1);
    Atomics.store(this.lock, 0, UNLOCKED);
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
          Debug('semaphore enter');
          resolve();
        }
      }, 10);
    });
  }

  leave() {
    Atomics.store(this.lock, 0, UNLOCKED);
    Debug('semaphore leave');
    return true;
  }
}

module.exports = Semaphore;
