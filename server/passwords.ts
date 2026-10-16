import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  const [, salt, digest] = hash.split(':');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(digest, 'hex'));
}
