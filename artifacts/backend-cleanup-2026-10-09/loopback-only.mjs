import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const output = path.resolve('artifacts/backend-cleanup-2026-10-09');
let blockedAttempts = 0;
let localConnections = 0;
const local = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
function block() { blockedAttempts++; throw new Error('BACKEND_CLEANUP_EXTERNAL_NETWORK_FORBIDDEN'); }
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!local(url.hostname) || !['http:', 'https:'].includes(url.protocol)) block();
  return nativeFetch(input, init);
};
function authorize(args) {
  if (Array.isArray(args[0])) args = args[0];
  const first = args[0];
  if (first && typeof first === 'object' && first.path) return;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return;
  const host = first && typeof first === 'object' ? first.host || first.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!local(host)) block();
  localConnections++;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { authorize(args); return connect.apply(this, args); };
const tlsConnect = tls.connect;
tls.connect = function (...args) { authorize(args); return tlsConnect.apply(this, args); };
dgram.Socket.prototype.send = block;
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync(path.join(output, `network-guard-${process.pid}.json`), JSON.stringify({guardInstalled: true, localConnections, blockedAttempts, externalAiRequests: 0}, null, 2)));
