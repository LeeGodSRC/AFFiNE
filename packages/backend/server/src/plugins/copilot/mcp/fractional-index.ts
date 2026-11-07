// Fractional indexing compatible with the AFFiNE frontend
// (packages/common/infra/src/utils/fractional-indexing.ts).
//
// `generateKeyBetween` is vendored from the `fractional-indexing` package
// (https://github.com/rocicorp/fractional-indexing, CC0-1.0) because the
// server image does not ship that dependency.

const BASE_62_DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INTEGER = 'A' + BASE_62_DIGITS[0].repeat(26);

function midpoint(a: string, b: string | null, digits: string): string {
  const zero = digits[0];
  if (b !== null && a >= b) {
    throw new Error(`${a} >= ${b}`);
  }
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error('trailing zero');
  }
  if (b) {
    let n = 0;
    while ((a[n] || zero) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
    }
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b !== null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    return digits[Math.round(0.5 * (digitA + digitB))];
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  return digits[digitA] + midpoint(a.slice(1), null, digits);
}

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  }
  if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new Error(`invalid order key head: ${head}`);
}

function validateInteger(int: string) {
  if (int.length !== getIntegerLength(int[0])) {
    throw new Error(`invalid integer part of order key: ${int}`);
  }
}

function getIntegerPart(key: string): string {
  const integerPartLength = getIntegerLength(key[0]);
  if (integerPartLength > key.length) {
    throw new Error(`invalid order key: ${key}`);
  }
  return key.slice(0, integerPartLength);
}

function validateOrderKey(key: string, digits: string) {
  if (key === SMALLEST_INTEGER) {
    throw new Error(`invalid order key: ${key}`);
  }
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === digits[0]) {
    throw new Error(`invalid order key: ${key}`);
  }
}

function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits[0];
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return 'a' + digits[0];
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') {
      digs.push(digits[0]);
    } else {
      digs.pop();
    }
    return h + digs.join('');
  }
  return head + digs.join('');
}

function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return 'Z' + digits.slice(-1);
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') {
      digs.push(digits.slice(-1));
    } else {
      digs.pop();
    }
    return h + digs.join('');
  }
  return head + digs.join('');
}

export function generateKeyBetween(
  a: string | null,
  b: string | null,
  digits = BASE_62_DIGITS
): string {
  if (a !== null) validateOrderKey(a, digits);
  if (b !== null) validateOrderKey(b, digits);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`${a} >= ${b}`);
  }
  if (a === null) {
    if (b === null) {
      return 'a' + digits[0];
    }
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) {
      return ib + midpoint('', fb, digits);
    }
    if (ib < b) {
      return ib;
    }
    const res = decrementInteger(ib, digits);
    if (res === null) {
      throw new Error('cannot decrement any more');
    }
    return res;
  }
  if (b === null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb, digits);
  }
  const i = incrementInteger(ia, digits);
  if (i === null) {
    throw new Error('cannot increment any more');
  }
  if (i < b) {
    return i;
  }
  return ia + midpoint(fa, null, digits);
}

const RANDOM_SIZE = 32;
const POSTFIX_CHARS =
  '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function postfix(length = RANDOM_SIZE) {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += POSTFIX_CHARS.charAt(values[i] % POSTFIX_CHARS.length);
  }
  return result;
}

function subkey(key: string | null) {
  if (key === null) return null;
  if (key.length <= RANDOM_SIZE + 1) return key;
  return key.substring(0, key.length - RANDOM_SIZE - 1);
}

function hasSamePrefix(a: string, b: string) {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Same contract as the frontend `generateFractionalIndexingKeyBetween`:
 * returns a key k with a < k < b (null = open end), suffixed with randomness.
 */
export function generateFractionalIndexingKeyBetween(
  a: string | null,
  b: string | null
) {
  if (a !== null && b !== null && a >= b) {
    throw new Error('a should be smaller than b');
  }
  const aSubkey = subkey(a);
  const bSubkey = subkey(b);

  if (aSubkey === null && bSubkey === null) {
    return generateKeyBetween(null, null) + '0' + postfix();
  }
  if (aSubkey === null) {
    return generateKeyBetween(null, bSubkey) + '0' + postfix();
  }
  if (bSubkey === null) {
    return generateKeyBetween(aSubkey, null) + '0' + postfix();
  }
  if (hasSamePrefix(aSubkey, bSubkey) && a !== null && b !== null) {
    return generateKeyBetween(a, b) + '0' + postfix();
  }
  return generateKeyBetween(aSubkey, bSubkey) + '0' + postfix();
}
