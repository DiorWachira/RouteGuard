/**
 * ISO 6346 container identification — owner code (3 letters) + equipment category (U/J/Z)
 * + 6-digit serial + check digit. Letters map to 10..38 skipping multiples of 11; each value is
 * weighted by 2^position, summed, taken mod 11, and a remainder of 10 becomes 0.
 * Sandbox convoys are labelled with valid codes under the fictional owner prefix "RGU".
 */

const LETTER_VALUES = (() => {
  const map = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    map[ch] = v++;
  }
  return map;
})();

export function checkDigit(code10) {
  const s = code10.toUpperCase();
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(s)) throw new Error(`Not an ISO 6346 prefix: ${code10}`);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const val = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValid(code11) {
  const s = code11.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{3}[UJZ]\d{7}$/.test(s) && checkDigit(s.slice(0, 10)) === Number(s[10]);
}

export function makeCode(serial, owner = 'RGU', category = 'U') {
  const body = `${owner}${category}${String(serial % 1e6).padStart(6, '0')}`;
  return { compact: `${body}${checkDigit(body)}`, owner: `${owner}${category}`, serial: body.slice(4), check: String(checkDigit(body)) };
}
