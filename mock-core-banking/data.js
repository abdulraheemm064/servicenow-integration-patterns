'use strict';
/**
 * Synthetic seed data for the mock core banking API. Every customer and account
 * is invented and generated deterministically.
 */

const PRODUCTS = {
  'CHK-STD': 'Standard Checking',
  'SAV-PLUS': 'Savings Plus',
  'BIZ-CHK': 'Business Checking',
};
const CURRENCIES = ['USD', 'EUR', 'GBP'];
const SEGMENTS = ['retail', 'premier', 'small-business'];

/** Tiny deterministic PRNG (mulberry32) so seed data is stable across runs. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeed(seed = 7) {
  const rand = prng(seed);
  const customers = new Map();
  for (let i = 1; i <= 40; i += 1) {
    const id = `CUST-${String(i).padStart(4, '0')}`;
    customers.set(id, {
      customerId: id,
      displayName: `Synthetic Customer ${String(i).padStart(4, '0')}`,
      segment: SEGMENTS[Math.floor(rand() * SEGMENTS.length)],
    });
  }
  const accounts = new Map();
  const productCodes = Object.keys(PRODUCTS);
  for (let i = 1; i <= 60; i += 1) {
    const accountNumber = `CB${String(10000000 + i)}`;
    const customerId = `CUST-${String(1 + Math.floor(rand() * 40)).padStart(4, '0')}`;
    accounts.set(accountNumber, {
      accountNumber,
      customerId,
      productCode: productCodes[Math.floor(rand() * productCodes.length)],
      currency: CURRENCIES[Math.floor(rand() * CURRENCIES.length)],
      balance: Math.round(rand() * 5000000) / 100,
      status: rand() < 0.9 ? 'ACTIVE' : 'FROZEN',
      openedOn: `2025-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-15`,
    });
  }
  return { customers, accounts };
}

module.exports = { PRODUCTS, CURRENCIES, buildSeed };
