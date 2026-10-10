// Test harness only. The existing strict transport owns request/retry/fallback policy.
// This guard constrains the single delegate and denies alternate networking APIs.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';

/** @param {{ nativeFetch: typeof globalThis.fetch, record?: (entry: Record<string, unknown>) => void }} options */
export function createPhase18NetworkGuard({ nativeFetch, record = () => {} }) {
  const context = new AsyncLocalStorage();
  const state = { researchProviderRequests: 0, generationProviderRequests: 0, totalExternalAiRequests: 0,
    patentPageRequests: 0, blockedAttempts: 0, installed: false, closed: false };
  const originals = [];
  function block(code) {
    state.blockedAttempts++;
    state.closed = true;
    record({ type: 'network-block', code });
    throw new Error(code);
  }
  function replace(object, key, value) {
    originals.push([object, key, object[key]]); object[key] = value;
  }
  function authorizeConnection(args) {
    let opts = args[0];
    if (Array.isArray(opts)) opts = opts[0];
    const host = typeof opts === 'object' ? opts?.host || opts?.hostname : args[1];
    const port = typeof opts === 'object' ? opts?.port : opts;
    if (!context.getStore() || state.closed || host !== context.getStore() || Number(port) !== 443) {
      block('PHASE18_UNAUTHORIZED_SOCKET');
    }
    record({ type: 'authorized-connection', hostname: host, port: 443 });
  }
  return {
    state,
    install() {
      if (state.installed) throw new Error('PHASE18_GUARD_ALREADY_INSTALLED');
      state.installed = true;
      replace(globalThis, 'fetch', async () => block('PHASE18_GLOBAL_FETCH_FORBIDDEN'));
      for (const object of [http, https]) for (const name of ['request', 'get']) replace(object, name, () => block('PHASE18_ALTERNATE_HTTP_FORBIDDEN'));
      for (const [object, name] of [[net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
        const original = object[name];
        replace(object, name, function(...args) { authorizeConnection(args); return original.apply(this, args); });
      }
      replace(dgram.Socket.prototype, 'send', () => block('PHASE18_DATAGRAM_FORBIDDEN'));
      syncBuiltinESMExports();
    },
    restore() {
      state.closed = true;
      for (const [object, key, original] of originals.reverse()) object[key] = original;
      syncBuiltinESMExports();
    },
    close() { state.closed = true; },
    async fetch(target, init = {}) {
      if (!state.installed || state.closed) block('PHASE18_GUARD_NOT_ACTIVE');
      const url = new URL(String(target));
      const headers = new Headers(init.headers);
      let kind;
      if (url.href === 'https://api.psydo.top/v1/responses') {
        let body;
        try { body = JSON.parse(init.body); } catch { block('PHASE18_INVALID_BODY'); }
        if (state.researchProviderRequests !== 0 || state.patentPageRequests !== 0 || init.method !== 'POST' ||
            init.redirect !== 'error' || body.model !== 'gpt-6-astra' || body.stream !== false || body.tool_choice !== 'required' ||
            JSON.stringify(body.include) !== '["web_search_call.action.sources"]' ||
            body.tools?.length !== 1 || body.tools[0]?.type !== 'web_search' ||
            JSON.stringify(body.tools[0]?.filters?.allowed_domains) !== '["patents.google.com"]' ||
            !headers.get('Authorization')?.startsWith('Bearer ')) block('PHASE18_PROVIDER_CONTRACT');
        state.researchProviderRequests++; state.totalExternalAiRequests++; kind = 'research';
      } else if (url.origin === 'https://patents.google.com' && !url.username && !url.password && !url.search && !url.hash &&
          /^\/patent\/[A-Z]{2}\d+[A-Z]\d?\/en$/u.test(url.pathname) && init.method === 'GET' && init.redirect === 'error' &&
          state.researchProviderRequests === 1 && !headers.has('Authorization') && !headers.has('x-api-key') && !headers.has('Cookie')) {
        state.patentPageRequests++; kind = 'patent-page';
      } else block('PHASE18_UNEXPECTED_DESTINATION');
      record({ type: 'network-dispatch', kind, hostname: url.hostname, pathname: url.pathname,
        method: init.method, credentialSent: kind === 'research', at: new Date().toISOString() });
      try {
        const response = await context.run(url.hostname, () => nativeFetch(target, init));
        record({ type: 'network-response', kind, hostname: url.hostname, pathname: url.pathname, httpStatus: response.status,
          redirected: response.redirected, contentType: ['application/json', 'text/html', 'text/plain'].includes(response.headers.get('content-type')?.split(';')[0]) ? response.headers.get('content-type').split(';')[0] : 'OTHER_OR_MISSING' });
        return response;
      } catch (error) {
        const codes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'];
        record({ type: 'network-error', kind, hostname: url.hostname, pathname: url.pathname,
          errorType: ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'Error',
          errorCode: codes.includes(error?.cause?.code || error?.code) ? error.cause?.code || error.code : 'UNKNOWN' });
        throw error;
      }
    },
  };
}
