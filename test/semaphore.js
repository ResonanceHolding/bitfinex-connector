'use strict';

const Semaphore = require('../lib/Semaphore.js');
const { delayMs } = require('../lib/utils.js');

const sem = new Semaphore();

(async () => {
  await sem.enter();
  console.log('Main enter');
  setTimeout(async () => {
    console.log('Settimeout');
    await sem.enter();
    console.log('Settimeout enter');
    await delayMs(1000);
    sem.leave();
    console.log('Settimeout leave');
  }, 1000);
  await delayMs(10000);
  sem.leave();
  console.log('Main leave');
})();
