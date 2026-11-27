import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const metadataNames = new Set(['metadata', 'metadata.google', 'metadata.google.internal', 'instance-data',
  'instance-data.ec2.internal', 'metadata.azure.internal']);
const deniedHeaders = new Set(['host', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'expect', 'forwarded', 'via', 'referer', 'origin', 'cookie', 'true-client-ip',
  'x-real-ip', 'x-host', 'x-rewrite-url', 'x-http-method', 'x-http-method-override', 'x-method-override',
  'x-envoy-original-path', 'x-remote-user', 'cf-worker', 'cdn-loop']);
const deniedPrefixes = /^(?:proxy-|forwarded-|x-forwarded-|x-original-|x-envoy-|x-accel-|x-amzn-|sec-|content-|cf-connecting-|cf-pseudo-)/;
const headerName = /^[0-9a-z-]{1,64}$/;
const configVar = /^[A-Z_][A-Z0-9_]{0,95}$/;
const valuePattern = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const maxResponseBytes = 2 * 1024 * 1024;

function blockedAddress(address) {
  if (address.includes('%')) return true;
  const ip = isIP(address);
  if (ip === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 0 || first >= 224 || (first === 169 && second === 254) ||
      ['100.100.100.200', '168.63.129.16', '192.0.0.192'].includes(address);
  }
  if (ip === 6) {
    const canonical = new URL('http://[' + address + ']').hostname.slice(1, -1);
    const first = Number.parseInt(canonical.split(':')[0], 16);
    return (canonical.startsWith('::') && canonical !== '::1') ||
      (first >= 0xfe80 && first <= 0xfebf) || first >= 0xff00 ||
      canonical.startsWith('fd00:ec2:') || canonical.startsWith('64:ff9b:') || first === 0x2002;
  }
  return true;
}

function loopback(address) {
  return (isIP(address) === 4 && address.startsWith('127.')) || address === '::1';
}

function invalidConfig() {
  return new Error('Invalid custom provider configuration');
}

export function customEndpoint(value, path) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/@]+(?:\/|$)/i.test(value) ||
    /[?#\\\s\x00-\x1f\x7f]/.test(value)) throw invalidConfig();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.username || url.password || metadataNames.has(hostname) ||
    (isIP(hostname) && blockedAddress(hostname))) throw invalidConfig();
  if (url.protocol === 'http:' && hostname !== 'localhost' && !loopback(hostname)) throw invalidConfig();
  if (path) url.pathname = url.pathname.replace(/\/+$/, '') + path;
  return url.href;
}

export function customHeaders(spec, env, endpoint, authEndpoint, reserved, live) {
  if (spec === undefined) return {};
  let entries;
  try {
    entries = JSON.parse(spec);
  } catch {
    throw invalidConfig();
  }
  if (!Array.isArray(entries) || entries.length > 12 ||
    (entries.length && (new URL(endpoint).protocol !== 'https:' || authEndpoint !== endpoint))) throw invalidConfig();
  const headers = new Map();
  const seen = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string')) throw invalidConfig();
    const [original, variable] = entry;
    const name = original.toLowerCase();
    if (!headerName.test(name) || deniedHeaders.has(name) || deniedPrefixes.test(name) ||
      !configVar.test(variable) || reserved.includes(variable) || seen.has(name)) throw invalidConfig();
    seen.add(name);
    const value = env[variable];
    if (!live && value === undefined) continue;
    if (typeof value !== 'string' || value.length > 8192 || !valuePattern.test(value)) throw invalidConfig();
    headers.set(name, value);
  }
  return Object.fromEntries(headers);
}

export function checkedLookup(hostname, options, callback, resolve = lookup) {
  resolve(hostname, { ...options, all: true }, (error, addresses) => {
    const local = hostname.replace(/\.$/, '').toLowerCase() === 'localhost';
    if (error || !addresses?.length || addresses.some(({ address }) => blockedAddress(address) || (local && !loopback(address)))) {
      callback(new Error('Endpoint resolution failed'));
      return;
    }
    // Use only the checked addresses when connecting. A later DNS lookup cannot change the target.
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export function directFetch(url, { method, headers, body, signal }) {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(target, {
      method, headers, signal, agent: false, lookup: checkedLookup, rejectUnauthorized: true,
    }, incoming => {
      const { statusCode: status } = incoming;
      if (status < 200 || status >= 300) {
        incoming.destroy();
        resolve({ ok: false, status, redirected: false });
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) incoming.destroy(new Error('Provider response exceeded size limit'));
        else chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => {
        resolve({ ok: true, status, redirected: false, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
