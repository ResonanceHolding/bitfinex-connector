'use strict';

function now() {
  const format = (num, count = 2) => {
    if (count === 2) return num > 9 ? `${num}` : `0${num}`;
    const len = num.toString().length;
    return `${'0'.repeat(count - len)}${num}`;
  };
  const date = new Date();
  const year = date.getUTCFullYear();
  const month = format(date.getUTCMonth() + 1, 2);
  const day = format(date.getUTCDate(), 2);
  const hour = format(date.getUTCHours(), 2);
  const minute = format(date.getUTCMinutes(), 2);
  const second = format(date.getUTCSeconds(), 2);
  const millisecond = format(date.getUTCMilliseconds(), 3);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}:${millisecond}`;
}

function Log(message) {
  console.log(`${now()} -> log -> ${message}`);
}

function Err(message) {
  console.log(
    '\x1b[41m\x1b[37m%s -> error ->\x1b[0m \x1b[31m%s\x1b[0m',
    `${now()}`,
    message
  );
}

function Info(message) {
  console.log(
    '\x1b[44m\x1b[37m%s -> info ->\x1b[0m \x1b[34m%s\x1b[0m',
    `${now()}`,
    message
  );
}

function Debug(message) {
  console.log(
    '\x1b[42m\x1b[37m%s -> debug ->\x1b[0m \x1b[32m%s\x1b[0m',
    `${now()}`,
    message
  );
}

module.exports = { Log, Err, Info, Debug };
