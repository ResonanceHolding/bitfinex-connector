'use strict';

const threads = require('node:worker_threads');
const { Worker, isMainThread } = threads;

const Mutex = require('../lib/Mutex.js');
const { delayMs } = require('../lib/utils.js');

(async () => {
  if (isMainThread) {
    const shared = new SharedArrayBuffer(8);
    const mutex = new Mutex({ shared, name: 'main', init: true });
    console.dir({ mutex });
    await mutex.enter();
    for (let i = 0; i < 10; ++i) {
      new Worker(__filename, { workerData: shared });
    }
    await delayMs(3000);
    mutex.leave();
  } else {
    const { threadId, workerData } = threads;
    const mutex = new Mutex({
      shared: workerData,
      name: `thread: ${threadId}`,
    });
    if (threadId === 1) {
      // await delayMs(500);
      await mutex.enter();
      await delayMs(1000);
      mutex.leave();
    } else {
      // await delayMs(100 * threadId);
      await mutex.enter();
      await delayMs(2000);
      mutex.leave();
    }
  }
})();
