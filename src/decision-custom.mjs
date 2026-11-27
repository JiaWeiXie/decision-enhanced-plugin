import { lookup } from 'node:dns';
import { isIP } from 'node:net';

const metadataNames = new Set(['metadata', 'metadata.google', 'metadata.google.internal', 'instance-data',
  'instance-data.ec2.internal', 'metadata.azure.internal']);
const allowedHeaders = new Set(['x-decision-client', 'x-decision-workspace', 'x-request-id']);
const authVariables = [
  ['authorization', 'DECISION_CUSTOM_BEARER_REF', 'Bearer '],
  ['x-api-key', 'DECISION_CUSTOM_API_KEY_REF', ''],
  ['x-goog-api-key', 'DECISION_CUSTOM_GEMINI_KEY_REF', ''],
  ['cf-access-client-id', 'DECISION_CUSTOM_ACCESS_ID_REF', ''],
  ['cf-access-client-secret', 'DECISION_CUSTOM_ACCESS_SECRET_REF', ''],
];
const credentialRef = /^DECISION_CUSTOM_CREDENTIAL_[A-Z0-9_]{1,64}$/;
const headerRef = /^DECISION_CUSTOM_HEADER_[A-Z0-9_]{1,64}$/;
const valuePattern = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

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
      canonical.startsWith('fd00:ec2:') || canonical === 'fd20:ce::254' ||
      canonical.startsWith('64:ff9b:') || first === 0x2002;
  }
  return true;
}

function loopback(address) {
  return (isIP(address) === 4 && address.startsWith('127.')) || address === '::1';
}

function invalidConfig() {
  return new Error('Invalid custom provider configuration');
}

function checkPath(path) {
  const unsafeEscape = /%(?:[01][0-9a-f]|20|23|25|2f|3f|5c|7f)|%(?![0-9a-f]{2})/i;
  // Some servers strip semicolon parameters before interpreting dot segments.
  const isDotSegment = segment => {
    const name = segment.split(/;|%3b/i, 1)[0];
    return /^\.{1,2}$/.test(name.replace(/%2e/gi, '.'));
  };
  if (!path.startsWith('/') || path.includes('//') || /[?#\\]|[^\x21-\x7e]/.test(path) ||
    unsafeEscape.test(path) || path.split('/').some(isDotSegment)) throw invalidConfig();
}

export function customEndpoint(value, path = '') {
  if (typeof value !== 'string' || /[?#\\]|[^\x21-\x7e]/.test(value)) throw invalidConfig();
  const parts = /^https:\/\/([^/@%]+)(\/.*)?$/i.exec(value);
  if (!parts) throw invalidConfig();
  if (path && !path.startsWith('/')) throw invalidConfig();
  const rawPath = parts[2] ?? '/';
  checkPath(rawPath);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig();
  }
  if (url.hostname.endsWith('..')) throw invalidConfig();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.username || url.password || metadataNames.has(hostname) ||
    (isIP(hostname) && blockedAddress(hostname))) throw invalidConfig();
  if (isIP(hostname) !== 6) url.hostname = hostname;

  const normalizedPath = rawPath.replace(/%([0-9a-f]{2})/gi, (encoded, code) => {
    const char = String.fromCharCode(Number.parseInt(code, 16));
    return /^[a-z0-9_.~-]$/i.test(char) ? char : encoded.toUpperCase();
  });
  const composed = path ? normalizedPath.replace(/\/$/, '') + path : normalizedPath;
  checkPath(composed);
  url.pathname = composed;
  return url.href;
}

export function customHeaderBindings(env, endpoint, authEndpoint) {
  const spec = env.DECISION_CUSTOM_HEADERS;
  let generic;
  try {
    generic = spec === undefined ? [] : JSON.parse(spec);
  } catch {
    throw invalidConfig();
  }
  if (!Array.isArray(generic) || generic.length > allowedHeaders.size) throw invalidConfig();
  const bindings = new Map();
  for (const entry of generic) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string')) throw invalidConfig();
    const [original, variable] = entry;
    const name = original.toLowerCase();
    if (!allowedHeaders.has(name) || !headerRef.test(variable) || bindings.has(name)) throw invalidConfig();
    bindings.set(name, { variable, prefix: '', credential: false });
  }

  const typed = authVariables.filter(([, name]) => env[name] !== undefined);
  const apiAuthCount = typed.filter(([header]) => !header.startsWith('cf-access-')).length;
  const accessCount = typed.length - apiAuthCount;
  if (apiAuthCount > 1 || accessCount === 1 || ((typed.length || generic.length) && authEndpoint !== endpoint)) {
    throw invalidConfig();
  }
  for (const [header, name, prefix] of typed) {
    const variable = env[name];
    if (!credentialRef.test(variable)) throw invalidConfig();
    bindings.set(header, { variable, prefix, credential: true });
  }
  return bindings;
}

export function resolveCustomHeaders(bindings, env, live) {
  const headers = {};
  const credentialNames = [];
  const values = [];
  const genericValues = [];
  for (const [name, { variable, prefix, credential }] of bindings) {
    const value = env[variable];
    if (!live && value === undefined) continue;
    if (typeof value !== 'string' || value.length > 8192 || !valuePattern.test(value)) throw invalidConfig();
    if (credential) {
      credentialNames.push(variable);
      if (/\s/.test(value)) throw invalidConfig();
      values.push(value);
    } else {
      genericValues.push(value);
    }
    headers[name] = prefix + value;
  }
  return { headers, credentialNames, values, genericValues };
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
