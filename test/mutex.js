'use strict';

const threads = require('node:worker_threads');
const { Worker, isMainThread } = threads;

const Mutex = require('../lib/Mutex.js');
const { delayMs } = require('../lib/utils.js');

(async () => {
  if (isMainThread) {
    const buffer = new SharedArrayBuffer(8);
    const mutex = new Mutex(buffer, 0, true);
    console.dir({ mutex });
    await mutex.enter();
    for (let i = 0; i < 10; ++i) {
      new Worker(__filename, { workerData: buffer });
    }
    await delayMs(3000);
    mutex.leave();
  } else {
    const { threadId, workerData } = threads;
    const mutex = new Mutex(workerData);
    if (threadId === 1) {
      // await delayMs(500);
      await mutex.enter();
      console.log('Entered mutex tread: %d', threadId);
      await delayMs(1000);
      mutex.leave();
      console.log('Left mutex tread: %d', threadId);
    } else {
      // await delayMs(100 * threadId);
      await mutex.enter();
      console.log('Entered mutex tread: %d', threadId);
      await delayMs(2000);
      mutex.leave();
      console.log('Left mutex tread: %d', threadId);
    }
  }
})();
