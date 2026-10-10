import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const directory = process.env.PHASE16B_ARTIFACT_DIR;
if (!directory || path.resolve(directory).startsWith(`${process.cwd()}${path.sep}`) || path.resolve(directory) === process.cwd()) {
  throw new Error('EXTERNAL_OFFLINE_ARTIFACT_DIR_REQUIRED');
}
let blockedAttempts = 0;
const block = () => {
  blockedAttempts++;
  throw new Error('PHASE16B_OUTBOUND_FORBIDDEN');
};
globalThis.fetch = async () => block();
http.request = http.get = https.request = https.get = block;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = block;
dgram.Socket.prototype.send = block;
syncBuiltinESMExports();
process.on('exit', () => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `network-guard-${process.pid}.json`), JSON.stringify({
    guardInstalled: true, blockedAttempts,
    realResearchRequests: 0, realGenerationRequests: 0, totalExternalAIRequests: 0,
  }));
});
