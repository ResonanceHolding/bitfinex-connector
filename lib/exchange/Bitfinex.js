'use strict';

const EventEmitter = require('node:events');
const ws = require('ws');
const Mutex = require('../Mutex.js');
const Semaphore = require('../Semaphore.js');

const { delayMs } = require('../utils.js');
const { Log, Info, Err, Debug } = require('../logger.js');
const Counter = require('../Counter.js');

const waitKeyInMap = (map, key) =>
  new Promise((resolve) => {
    const interval = setInterval(
      (map) => {
        if (map.has(key)) {
          clearInterval(interval);
          resolve(true);
        }
      },
      100,
      map
    );
  });

class BitfinexClient extends EventEmitter {
  #socket;
  #ready = false;
  #tradesSub = new Map();
  #channels = new Map();
  #channelsOp = new Map();
  #pingInterval;
  #pingThrottle = 25000;
  constructor(id, parent, responseTimeout = 30000) {
    super();
    this.id = id;
    this.parent = parent;
    this.wsOptions = {
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    };
    this.responseTimeout = responseTimeout;
    this.setMaxListeners(Number.POSITIVE_INFINITY);
    this.connect();
    this.on('ready', () => this.startPing());
  }

  connect() {
    this.#socket = new ws('wss://api-pub.bitfinex.com/ws/2', this.wsOptions);
    this.#socket.on('message', this.onMessage.bind(this));
    this.#socket.on('open', () => {
      this.emit('open');
    });
    this.#socket.on('error', (err) => {
      this.emit('error', err);
    });
    this.#socket.on('unexpected-response', (err) => {
      this.emit('error', err);
    });
    this.#socket.on('close', (code, reason) => {
      Err(`Connect ${this.id} closed code: ${code}`);
      Err(reason);
      this.reconnect();
    });
  }

  async reconnect() {
    this.stopPing();
    this.#socket.removeAllListeners();
    if (this.parent) await this.parent.locker.enter();
    this.#socket = new ws('wss://api-pub.bitfinex.com/ws/2', this.wsOptions);
    this.#socket.on('message', this.onMessage.bind(this));
    this.#socket.once('open', async () => {
      this.emit('open');
      if (this.parent)
        setTimeout(() => this.parent.locker.leave(), this.parent.throttleMs);
      for (const [, market] of this.#tradesSub.entries()) {
        await this.subscribeTrades(market);
      }
    });
    this.#socket.on('error', (err) => {
      this.emit('error', err);
    });
    this.#socket.on('unexpected-response', (err) => {
      this.emit('error', err);
    });
    this.#socket.on('close', async (code, reason) => {
      Err(`Connect ${this.id} closed code: ${code}`);
      Err(reason);
      await this.reconnect();
    });
  }

  async close() {
    this.#socket.close();
    this.#socket.removeAllListeners();
  }

  async isReady() {
    return new Promise((resolve) => {
      if (this.#ready) resolve();
      this.once('ready', resolve);
    });
  }

  startPing() {
    if (this.#pingInterval) clearInterval(this.#pingInterval);
    this.#pingInterval = setInterval(
      this.sendPing.bind(this),
      this.#pingThrottle
    );
  }

  stopPing() {
    if (this.#pingInterval) clearInterval(this.#pingInterval);
  }

  sendPing() {
    if (this.#socket) {
      this.#socket.send(
        JSON.stringify({
          event: 'ping',
          cid: 1234,
        })
      );
    }
  }

  send(msg) {
    this.#socket.send(JSON.stringify(msg));
    this.startPing();
  }

  #emitInfo(msg) {
    let decode;
    if (Object.prototype.hasOwnProperty.call(msg, 'platform')) {
      const { version, platform } = msg;
      if (version !== 2) throw new Error(`Unsupported API version: ${version}`);
      const decoder = {
        1: () => {
          this.#ready = true;
          this.emit('ready');
        },
        0: () => {
          this.#ready = false;
          this.stopPing();
        },
      };
      decode = decoder[platform.status];
      if (!decode) {
        this.emit('error', 'unknown platform status');
        console.log(msg);
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'code')) {
      const decoder = {
        20051: () => this.reconnect(),
        20060: () => {
          this.#ready = false;
          this.stopPing();
        },
        20061: () => {
          this.#ready = true;
          this.emit('ready');
        },
      };
      decode = decoder[msg.code];
      if (!decode) {
        this.emit('error', 'Unknown info code status');
        return;
      }
    }
    if (!decode) this.emit('error', 'Unknown info message');
    else decode();
  }

  #emitSubscribed(msg) {
    const { channel, chanId, pair, symbol } = msg;
    const decoder = {
      trades: () => {
        this.#channels.set(chanId, { pair, channel, symbol });
        this.#channelsOp.set(pair, chanId);
        this.emit(`subscribe-${pair}`, true);
      },
    };
    const decode = decoder[channel];
    if (!decode) this.emit('error', `Unsupported channel: ${channel}`);
    else decode();
  }

  #emitUnsubscribed(msg) {
    const { status, chanId } = msg;
    const pair = this.#channels.get(chanId)?.pair;
    if (!pair) return;
    if (status === 'OK') {
      this.#tradesSub.delete(pair);
      this.#channelsOp.delete(pair);
      this.#channels.delete(chanId);
      this.emit(`unsubscribe-${pair}`, true);
    } else this.emit(`unsubscribe-${pair}`, false);
  }

  #emitError(message) {
    const { code, msg } = message;
    this.emit('error', `${code}: ${msg}`);
    if (code === 10305) console.dir(this.parent.connects);
  }

  #emitPong(message) {
    const { cid } = message;
    this.emit('pong', cid);
  }

  #eventDecode(msg) {
    const { event } = msg;
    const decoder = {
      info: () => this.#emitInfo(msg),
      subscribed: () => this.#emitSubscribed(msg),
      unsubscribed: () => this.#emitUnsubscribed(msg),
      error: () => this.#emitError(msg),
      pong: () => this.#emitPong(msg),
    };
    const decode = decoder[event];
    if (!decode) this.emit('error', `Unknown event: ${event}`);
    else decode();
  }

  #updateDecode(msg) {
    const chanId = msg[0];
    const type = msg[1];
    const update = msg[2];
    const pair = this.#channels.get(chanId)?.pair;
    if (!pair) return;
    const market = this.#tradesSub.get(pair);
    if (!market) return;
    const decoder = {
      te: () => {},
      hb: () => {},
      tu: () => {
        let [id, unix, amount, price] = update;
        price = price.toFixed(8);
        const side = amount > 0 ? 'buy' : 'sell';
        amount = Math.abs(amount).toFixed(8);
        const sequenceId = Number(msg[3] ?? 0);
        const trade = {
          exchange: 'bitfinex',
          base: market.base,
          quote: market.quote,
          tradeId: id.toFixed(),
          sequenceId,
          unix: unix,
          side,
          price,
          amount,
          // clientId: `worker: ${this.parent.wId} socket: ${this.id}`,
        };
        this.emit('trade', trade, market);
      },
    };
    const decode = decoder[type];
    if (!decode) this.emit('error', `Unknown update type: ${type}`);
    else decode();
  }

  onMessage(msg) {
    const message = JSON.parse(msg);
    const isEvent = !Array.isArray(message);
    if (isEvent) return this.#eventDecode(message);
    const isUpdate = typeof message[1] === 'string';
    if (isUpdate) return this.#updateDecode(message);
    return;
    const { id } = this;
    console.dir({ id, message }, { depth: 4 });
  }

  async subscribeTrades(market) {
    return new Promise((resolve) => {
      this.isReady().then(() => {
        try {
          const key = market.id;
          if (this.#tradesSub.has(key)) resolve();
          this.send({
            event: 'subscribe',
            channel: 'trades',
            symbol: `t${key}`,
          });
          const timeout = setTimeout(() => {
            this.emit(`subscribe-${key}`, false);
          }, this.responseTimeout);
          this.once(`subscribe-${key}`, (cond) => {
            clearTimeout(timeout);
            if (cond) {
              this.#tradesSub.set(key, market);
              resolve(true);
            } else {
              resolve(false);
            }
          });
        } catch (err) {
          this.emit('error', err);
          resolve(false);
        }
      });
    });
  }

  async unsubscribeTrades(market) {
    return new Promise((resolve) => {
      this.isReady().then(async () => {
        try {
          const key = market.id;
          if (!this.#tradesSub.has(key)) resolve();
          await waitKeyInMap(this.#channelsOp, key);
          const chanId = this.#channelsOp.get(key);
          if (!chanId) {
            Debug(`unsubscribe ${key}, ${chanId}`);
            resolve(false);
          }
          this.send({
            event: 'unsubscribe',
            chanId,
          });
          const timeout = setTimeout(() => {
            this.emit(`unsubscribe-${key}`, false);
          }, this.responseTimeout);
          this.once(`unsubscribe-${key}`, (cond) => {
            clearTimeout(timeout);
            resolve(cond);
          });
        } catch (err) {
          this.emit('error', err);
          resolve(false);
        }
      });
    });
  }
}

class BitfinexMultiClient extends EventEmitter {
  #pairs = new Map();
  connects = [];
  constructor({
    shared = null,
    id = null,
    maxPairs = 25,
    throttleMs = 3000,
    responseTimeout = 30000,
    singleThread = false,
  }) {
    super();
    if (!shared && !id && !singleThread)
      throw new Error(
        'You should provide SharedArrayBuffer and thread id fom 0 to N'
      );
    this.wId = id;
    this.clientCount = 0;
    this.setMaxListeners(Number.POSITIVE_INFINITY);
    this.maxPairs = maxPairs;
    this.throttleMs = throttleMs;
    this.responseTimeout = responseTimeout;
    this.locker = this.createLoc(singleThread, shared, id);
    this.sem1 = new Semaphore();
  }

  createLoc(singleThread, shared, id) {
    if (singleThread) return new Semaphore('Create client single thread mod');
    const mutexOptions = {
      shared,
      name: `Worker id: ${id}`,
    };
    if (id === 0) mutexOptions.init = true;
    return new Mutex(mutexOptions);
  }

  async reconnect() {
    for (const { client } of this.connects) {
      await client.reconnect();
    }
  }

  async close() {
    for (const { client } of this.connects) {
      await client.close();
    }
  }

  createBasicClient(id) {
    return new BitfinexClient(id, this, this.responseTimeout);
  }

  #createBasicClientThrottled() {
    return new Promise(async (resolve) => {
      await this.locker.enter();
      const client = this.createBasicClient(this.clientCount);
      this.clientCount++;
      client.on('open', (msg) => this.emit('open', msg));
      client.on('closed', (msg) => this.emit('closed', msg));
      client.on('error', (err) => this.emit('error', err));
      client.on('trade', (trade, market) => this.emit('trade', trade, market));
      const clearSem = async () => {
        await delayMs(this.throttleMs);
        this.locker.leave();
        resolve(client);
      };
      client.once('ready', clearSem);
    });
  }

  async #getClient(pair) {
    let cond = false;
    let client;
    if (this.#pairs.has(pair)) {
      client = this.#pairs.get(pair);
      if (await client.count.compareInc(this.maxPairs)) {
        return client;
      }
    }
    if (this.connects.length > 0) {
      for (const row of this.connects) {
        if (await row.count.compareInc(this.maxPairs)) {
          client = row;
          cond = true;
          break;
        }
      }
      if (cond) {
        this.#pairs.set(pair, client);
        return client;
      }
    }
    client = {
      client: this.#createBasicClientThrottled(),
      count: new Counter(1),
    };
    this.#pairs.set(pair, client);
    this.connects.push(client);
    return client;
  }

  async subscribe(market, type) {
    try {
      // getClient
      await this.sem1.enter();
      const clientRow = await this.#getClient(market.id);
      this.sem1.leave();

      // wait for client to be made!
      const client = await clientRow.client;

      const decoder = {
        trade: async () => await client.subscribeTrades(market),
      };
      const decode = decoder[type];
      if (decode) {
        const res = decode();
        if (res) return true;
      }

      clientRow.count.dec();
      return false;
    } catch (err) {
      this.emit('error', err);
    }
  }

  async subscribeTrades(market) {
    const ret = await this.subscribe(market, 'trade');
    return ret;
  }

  async unsubscribeTrades(market) {
    if (!this.#pairs.has(market.id)) return;
    const client = await this.#pairs.get(market.id).client;
    const ret = await client.unsubscribeTrades(market);
    if (ret) this.#pairs.get(market.id).count.dec();
    return ret;
  }
}

module.exports = {
  // BitfinexClient,
  BitfinexMultiClient,
};
