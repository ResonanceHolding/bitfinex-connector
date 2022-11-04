'use strict';

const { Debug } = require('./logger.js');

const LOCKED = 0n;
const UNLOCKED = 1n;

class Semaphore {
  constructor(name) {
    this.name = name;
    const buffer = new ArrayBuffer(8);
    this.lock = new BigInt64Array(buffer, 0, 1);
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
          if(this.name) Debug(`semaphore ${this.name} enter`);
          resolve();
        }
      }, 10);
    });
  }

  leave() {
    Atomics.store(this.lock, 0, UNLOCKED);
    if(this.name) Debug(`semaphore ${this.name} leave`);
    return true;
  }
}

module.exports = Semaphore;
