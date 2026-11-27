import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { checkedLookup } from './decision-custom.mjs';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_DEPTH = 32;
const CONNECT_TIMEOUT_MS = 5_000;

export function directFetch(url, { method, headers, body, signal }) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(target, {
      method, headers, signal, agent: false, lookup: checkedLookup,
      ...(secure ? { rejectUnauthorized: true, ca: rootCertificates } : {}),
    }, incoming => {
      clearTimeout(connectTimer);
      const status = incoming.statusCode;
      if (status < 200 || status >= 300 || status === 204 || status === 205) {
        incoming.destroy();
        resolve(new Response(null, { status }));
        return;
      }
      const stream = Readable.toWeb(incoming, {
        strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.length },
      });
      resolve(new Response(stream, {
        status, headers: { 'Content-Type': incoming.headers['content-type'] ?? '' },
      }));
    });
    const connectTimer = setTimeout(() => request.destroy(new Error('Provider connect timeout')), CONNECT_TIMEOUT_MS);
    connectTimer.unref();
    request.once('socket', socket => {
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    request.once('error', error => {
      clearTimeout(connectTimer);
      reject(error);
    });
    request.end(body);
  });
}

function discardBody(response) {
  void response.body?.cancel().catch(() => {});
}

function rejectDuplicateKeys(text) {
  const stack = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else {
      const fields = stack.at(-1);
      const next = /\s*:/y;
      next.lastIndex = match.index + token.length;
      if (fields && next.test(text)) {
        const name = JSON.parse(token);
        if (fields.has(name)) throw new Error('Provider response has duplicate fields');
        fields.add(name);
      }
    }
  }
}

async function boundedJSON(response, signal) {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || !/^(?:application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(type)) {
    discardBody(response);
    throw new Error('Invalid provider response type');
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let bytes = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Provider response exceeds byte limit');
      for (const byte of value) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quoted = false;
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
          depth++;
          if (depth > MAX_RESPONSE_DEPTH) throw new Error('Provider response exceeds nesting limit');
        } else if (byte === 125 || byte === 93) {
          depth--;
          if (depth < 0) throw new Error('Invalid provider response structure');
        }
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    if (depth !== 0 || quoted) throw new Error('Incomplete provider response structure');
    chunks.push(decoder.decode());
    const text = chunks.join('');
    rejectDuplicateKeys(text);
    return text;
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

// Reconstruct transport headers from the bound credential configuration. The SDK
// cannot add authorization, cookies, routing headers, or retry credentials elsewhere.
export function pinnedFetch({ endpoint, headers }, fetchImpl, guardBody) {
  return async (url, init) => {
    if (url !== endpoint || init?.method !== 'POST') throw new Error('Invalid provider endpoint');
    init.signal?.throwIfAborted();
    if (typeof init.body !== 'string') throw new Error('Invalid serialized request');
    guardBody(init.body);
    const response = await fetchImpl(url, {
      method: 'POST', body: init.body, signal: init.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (response.redirected || (response.url && response.url !== endpoint) ||
      (response.status >= 300 && response.status < 400)) {
      discardBody(response);
      throw new Error('Provider redirect refused');
    }
    if (!response.ok) {
      discardBody(response);
      return new Response(null, { status: response.status });
    }
    const text = await boundedJSON(response, init.signal);
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  };
}
