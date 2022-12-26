'use strict';

const Semaphore = require('./Semaphore');

class Counter {
  #semaphore;
  #counter = 0;
  constructor(init = 0, marker) {
    this.#semaphore = new Semaphore(marker);
    this.#counter = init;
  }

  async compareInc(value) {
    await this.#semaphore.enter();
    let cond = false;
    if (this.#counter < value - 1) {
      this.#counter++;
      cond = true;
    }
    this.#semaphore.leave();
    return cond;
  }

  async inc() {
    await this.#semaphore.enter();
    this.#counter++;
    this.#semaphore.leave();
    return true;
  }

  async dec() {
    await this.#semaphore.enter();
    this.#counter--;
    this.#semaphore.leave();
    return true;
  }

  get counter() {
    return this.#counter;
  }
}

module.exports = Counter;
