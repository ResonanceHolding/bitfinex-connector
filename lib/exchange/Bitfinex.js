'use strict';

const EventEmitter = require('node:events');
const ws = require('ws');
const Mutex = require('../Mutex.js');

const { delayMs } = require('../utils.js');
const { Log, Info, Err, Debug } = require('../logger.js');

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
  constructor(id, parent) {
    super();
    this.id = id;
    this.parent = parent;
    this.wsOptions = {
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    };
    this.setMaxListeners(Number.POSITIVE_INFINITY);
    this.connect();
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
    this.#socket.removeAllListeners();
    if (this.parent) await this.parent.mutex.enter();
    this.#socket = new ws('wss://api-pub.bitfinex.com/ws/2', this.wsOptions);
    this.#socket.on('message', this.onMessage.bind(this));
    this.#socket.once('open', async () => {
      this.emit('open');
      if (this.parent)
        setTimeout(() => this.parent.mutex.leave(), this.parent.throttleMs);
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
    }
  }

  #emitError(message) {
    const { code, msg } = message;
    this.emit('error', `${code}: ${msg}`);
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
          this.#socket.send(
            JSON.stringify({
              event: 'subscribe',
              channel: 'trades',
              symbol: `t${key}`,
            })
          );
          this.#tradesSub.set(key, market);
          resolve(true);
        } catch (err) {
          this.emit('error', err);
          resolve(false);
        }
      });
    });
  }

  async unsubscribeTrades(market) {
    return new Promise((resolve) => {
      this.isReady().then(async() => {
        try {
          const key = market.id;
          if (!this.#tradesSub.has(key)) resolve();
          await waitKeyInMap(this.#channelsOp,key);
          const chanId = this.#channelsOp.get(key);
          this.#socket.send(
            JSON.stringify({
              event: 'unsubscribe',
              chanId,
            })
          );
          if (!chanId) Debug(`unsubscribe ${key}, ${chanId}`);
          resolve(true);
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
  #connects = [];
  constructor({ shared = null, id = null, maxPairs = 25, throttleMs = 3000 }) {
    super();
    if (!shared && !id)
      throw new Error('You should provide SharedArrayBuffer and thread id');
    this.wId = id;
    this.clientCount = 0;
    this.setMaxListeners(Number.POSITIVE_INFINITY);
    this.maxPairs = maxPairs;
    this.throttleMs = throttleMs;
    this.mutex = id === 0 ? new Mutex(shared, 0, true) : new Mutex(shared);
  }

  async reconnect() {
    for (const { client } of this.#connects) {
      await client.reconnect();
      delayMs(this.throttleMs);
    }
  }

  async close() {
    for (const { client } of this.#connects) {
      await client.close();
    }
  }

  async throttling() {
    await this.mutex.enter();
    await delayMs(this.throttleMs);
    this.mutex.leave();
  }

  async subscribeTrades(market) {
    return await this.subscribe(market, 'trade');
  }

  createBasicClient(id) {
    return new BitfinexClient(id, this);
  }

  #createBasicClientThrottled() {
    return new Promise(async (resolve) => {
      await this.mutex.enter();
      const client = this.createBasicClient(this.clientCount);
      this.clientCount++;
      client.on('open', (msg) => this.emit('open', msg));
      client.on('closed', (msg) => this.emit('closed', msg));
      client.on('error', (err) => this.emit('error', err));
      client.on('trade', (trade, market) => this.emit('trade', trade, market));
      const clearSem = async () => {
        await delayMs(this.throttleMs);
        this.mutex.leave();
        resolve(client);
      };
      client.once('ready', clearSem);
    });
  }

  #getClient() {
    let cond = false;
    let client;
    if (this.#connects.length > 0) {
      for (const row of this.#connects) {
        if (row.count < this.maxPairs) {
          client = row;
          cond = true;
          break;
        }
      }
      if (cond) return client;
    }
    client = {
      client: this.#createBasicClientThrottled(),
      count: 0,
    };
    this.#connects.push(client);
    return client;
  }

  async subscribe(market, type) {
    try {
      const remote_id = market.id;
      let clientRow = null;
      // construct a client
      if (!this.#pairs.has(remote_id)) {
        // getClient
        clientRow = this.#getClient();
        // we MUST store the promise in here otherwise we will stack up duplicates
        this.#pairs.set(remote_id, clientRow);
      } else {
        clientRow = this.#pairs.get(remote_id);
      }

      // wait for client to be made!
      const client = await clientRow.client;

      if (type === 'trade') {
        const subscribed = await client.subscribeTrades(market);
        if (subscribed) {
          clientRow.count++;
          return true;
        }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  async unsubscribeTrades(market) {
    if (!this.#pairs.has(market.id)) return;
    const client = await this.#pairs.get(market.id).client;
    const ret = await client.unsubscribeTrades(market);
    if (ret) this.#pairs.get(market.id).count--;
    return ret;
  }
}

module.exports = {
  BitfinexClient,
  BitfinexMultiClient,
};
