'use strict';

const delayMs = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  delayMs,
};
