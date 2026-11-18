import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);

export async function passwordHash(password, salt) {
  return Buffer.from(await deriveKey(password, salt, 64)).toString('hex');
}

export async function verifyPassword(account, password) {
  const candidate = await passwordHash(password, account?.salt || 'northgo-unconfigured');
  const expected = account?.password_hash || '0'.repeat(128);
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex')) && !!account;
}

export function passwordIsValid(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 256;
}
