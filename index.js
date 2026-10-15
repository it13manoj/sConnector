require('dotenv').config();
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
const express = require('express');
const http = require('http');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isIP } = require('net');
const store = require('./sync');
const { createRemoteDesktop } = require('./remote-control');
const { createRelayClient } = require('./relay-client');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const reachableAddresses = getReachableAddresses();
config.peers = Array.isArray(config.peers) ? config.peers : [];
const localHostname = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '') || 'node';
const expectedPrefix = `node-${localHostname}-`;
if (!config.nodeId || !config.nodeId.startsWith(expectedPrefix)) {
  config.nodeId = `node-${localHostname}-${crypto.randomUUID().slice(0, 8)}`;
  saveConfig();
}

function isSelfHub(hubUrl) {
  if (!hubUrl) return true;
  try {
    const parsed = new URL(hubUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;
    for (const addr of reachableAddresses) {
      if (addr.toLowerCase() === hostname) return true;
    }
    if (hostname === 'system.connect.parakshtech.com') {
      if (reachableAddresses.includes('173.212.235.87')) return true;
    }
  } catch {}
  return false;
}

const isHub = isSelfHub(process.env.HUB_URL);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const localClients = new Set();
const peerStates = new Map();
const syncIntervalMs = 5000;
const remoteDesktop = createRemoteDesktop(config.nodeId, {
  onHostRegistered: (host) => {
    console.log(`[RELAY] Host "${host.nodeId}" connected, syncing peers.`);
    void syncAllPeers();
  }
});

let relayClient = null;
if (process.env.HUB_URL && !isHub) {
  relayClient = createRelayClient({
    hubUrl: process.env.HUB_URL,
    nodeId: config.nodeId,
    getLocalIps: () => reachableAddresses,
    store,
    remoteDesktop,
    onSyncChange: () => {
      sendLocalUpdate();
      void syncAllPeers();
    }
  });
  relayClient.start();
} else if (isHub) {
  console.log('[HUB] Running as central Relay Hub on https://system.connect.parakshtech.com');
}

function isPrivateAddress(address) {
  if (address === '::1') return true;
  if (address.includes(':')) return /^f[cd]/i.test(address);

  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    octets[0] === 127;
}

function isLinkLocal(ip) {
  return typeof ip === 'string' && /^fe[89ab]/i.test(ip);
}

function getReachableAddresses() {
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry && entry.address && isIP(entry.address)) {
        if (isLinkLocal(entry.address)) continue;
        addresses.add(entry.address);
      }
    }
  }
  if (!addresses.size) addresses.add('127.0.0.1');
  return [...addresses];
}

function saveConfig() {
  const temporaryFile = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temporaryFile, CONFIG_FILE);
}

function isValidHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (isIP(clean)) return true;
  if (clean === 'localhost') return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(clean);
}

function normalizePeerAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error('Enter a peer host address or URL.');
  }

  let input = address.trim();
  const hasExplicitProtocol = /^https?:\/\//i.test(input);
  if (!hasExplicitProtocol) {
    const hostPart = input.split('/')[0];
    const isDomainWithoutPort = !isIP(hostPart.replace(/^\[|\]$/g, '')) && !hostPart.includes(':') && hostPart.includes('.');
    input = isDomainWithoutPort ? `https://${input}` : `http://${input}`;
  }

  let peer;
  try {
    peer = new URL(input);
  } catch {
    throw new Error('Enter a valid host or URL (e.g. system.connect.parakshtech.com or 192.168.1.20:3000).');
  }

  if (!['http:', 'https:'].includes(peer.protocol) ||
      !isValidHost(peer.hostname) ||
      peer.username || peer.password ||
      (peer.pathname !== '/' && peer.pathname !== '') ||
      peer.search || peer.hash) {
    throw new Error('Peers must be a valid host/domain with optional port (e.g. system.connect.parakshtech.com).');
  }

  if (!peer.port) {
    if (peer.protocol === 'http:' && (isIP(peer.hostname.replace(/^\[|\]$/g, '')) || peer.hostname === 'localhost')) {
      peer.port = String(port);
    }
  }

  return `${peer.protocol}//${peer.host}`;
}

function validatePeerAddress(address) {
  const normalized = normalizePeerAddress(address);
  const peer = new URL(normalized);
  const host = peer.hostname.replace(/^\[|\]$/g, '');
  if ((peer.port === String(port) || (!peer.port && (port === 80 || port === 443))) &&
      (host === '127.0.0.1' || host === '::1' || host === 'localhost')) {
    throw new Error('This address points back to this app.');
  }
  return normalized;
}

function getBestDisplayIp(localIps, publicIp) {
  if (Array.isArray(localIps)) {
    const ipv4s = localIps.filter((ip) => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1');
    const physicalIps = ipv4s.filter((ip) => !ip.startsWith('172.22.') && !ip.startsWith('172.17.'));
    if (physicalIps.length) return physicalIps[0];
    if (ipv4s.length) return ipv4s[0];
  }
  return publicIp || null;
}

function publicPeers() {
  const list = [];
  const seenAddresses = new Set();

  for (const url of config.peers) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const isRelayed = remoteDesktop.hasRegisteredHost(host);
      const state = peerStates.get(url);
      const addr = u.host;
      seenAddresses.add(addr.toLowerCase());
      if (host) seenAddresses.add(host);
      list.push({
        address: addr,
        status: isRelayed ? 'online' : (state?.status || 'checking'),
        lastSeen: isRelayed ? Date.now() : (state?.lastSeen || null),
        error: isRelayed ? null : (state?.error || null),
        isConfigured: true
      });
    } catch {}
  }

  // Active hosts connected via WebSocket relay (Hub mode)
  const activeHosts = remoteDesktop.getRegisteredHosts();
  for (const h of activeHosts) {
    if (h.nodeId === config.nodeId) continue;
    const ip = getBestDisplayIp(h.localIps, h.publicIp);
    const addr = ip ? `${ip}:${port}` : h.nodeId;
    const cleanIp = (ip || '').toLowerCase();
    const cleanNode = (h.nodeId || '').toLowerCase();

    if (!seenAddresses.has(addr.toLowerCase()) && !seenAddresses.has(cleanIp) && !seenAddresses.has(cleanNode)) {
      seenAddresses.add(addr.toLowerCase());
      if (cleanIp) seenAddresses.add(cleanIp);
      if (cleanNode) seenAddresses.add(cleanNode);
      list.push({
        address: addr,
        nodeId: h.nodeId,
        status: 'online',
        lastSeen: Date.now(),
        error: null,
        publicIp: h.publicIp,
        platform: h.platform,
        isConfigured: false
      });
    }
  }

  return list;
}

function sendLocalUpdate() {
  const message = `data: ${JSON.stringify(store.getVisible())}\n\n`;
  for (const client of localClients) client.write(message);
}

async function syncPeer(url) {
  const peerHost = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // 1. If host is connected directly to Relay Hub, sync over WebSocket!
  if (remoteDesktop.hasRegisteredHost(peerHost)) {
    try {
      const res = await remoteDesktop.syncOverRelay(peerHost, store.getAll());
      if (res && res.payload) {
        const changed = store.merge(res.payload);
        if (changed) {
          sendLocalUpdate();
          void syncAllPeersExcept(url);
        }
      }
      const previous = peerStates.get(url);
      peerStates.set(url, { status: 'online', lastSeen: Date.now(), error: null });
      if (previous?.status !== 'online') {
        console.log(`[SYNC] ${url} connected via relay.`);
      }
      return res;
    } catch (relayErr) {
      // Fallback
    }
  }

  // 2. If this node is connected to a central Hub, sync through the Hub!
  if (relayClient && relayClient.isConnected()) {
    try {
      const res = await relayClient.syncOverHub(peerHost, store.getAll());
      if (res && res.payload) {
        const changed = store.merge(res.payload);
        if (changed) {
          sendLocalUpdate();
          void syncAllPeersExcept(url);
        }
      }
      const previous = peerStates.get(url);
      peerStates.set(url, { status: 'online', lastSeen: Date.now(), error: null });
      if (previous?.status !== 'online') {
        console.log(`[SYNC] ${url} connected via Hub relay.`);
      }
      return res;
    } catch (hubErr) {
      // Fallback
    }
  }

  const isPrivate = isPrivateAddress(peerHost);
  const isPublicServer = !reachableAddresses.some((ip) => isPrivateAddress(ip));
  if (isPrivate && isPublicServer) {
    const previous = peerStates.get(url);
    const message = 'System offline (open SConnect on PC to connect)';
    peerStates.set(url, { status: 'offline', lastSeen: previous?.lastSeen || null, error: message });
    if (previous?.status !== 'offline') {
      console.warn(`[SYNC] ${url}: ${message}`);
    }
    return null;
  }

  try {
    const response = await axios.post(`${url}/api/sync`, {
      type: 'UPDATE',
      from: config.nodeId,
      payload: store.getAll()
    }, { timeout: 3000 });
    const remoteData = response.data?.payload?.data;
    if (remoteData) {
      const changed = store.merge(remoteData);
      if (changed) {
        sendLocalUpdate();
        void syncAllPeersExcept(url);
      }
    }
    const previous = peerStates.get(url);
    peerStates.set(url, { status: 'online', lastSeen: Date.now(), error: null });
    if (previous?.status !== 'online') {
      console.log(`[SYNC] ${url} connected.`);
    }
    return response.data;
  } catch (error) {
    const message = error.response
      ? `Peer returned HTTP ${error.response.status}`
      : error.code === 'ECONNABORTED'
        ? (isPrivate ? 'System offline (open SConnect on PC to connect)' : 'Connection timed out')
        : 'Could not connect';
    const previous = peerStates.get(url);
    peerStates.set(url, { status: 'offline', lastSeen: previous?.lastSeen || null, error: message });
    if (previous?.status !== 'offline') {
      console.warn(`[SYNC] ${url}: ${message}`);
    }
    return null;
  }
}

async function syncAllPeers() {
  await Promise.all(config.peers.map((url) => syncPeer(url)));
}

function processPacket(packet, exceptPeer) {
  if (!packet || !packet.payload || !packet.payload.data) {
    const error = new Error('Invalid sync packet.');
    error.status = 400;
    throw error;
  }
  if (!['UPDATE', 'FULL_SYNC'].includes(packet.type)) {
    const error = new Error('Unsupported sync packet type.');
    error.status = 400;
    throw error;
  }

  const changed = store.merge(packet.payload.data);
  if (changed) {
    console.log(`[SYNC] Merged updates from ${packet.from || 'peer'}`);
    sendLocalUpdate();
    void syncAllPeersExcept(exceptPeer);
  }
  return changed;
}

async function syncAllPeersExcept(exceptPeer) {
  const peers = config.peers.filter((url) => url !== exceptPeer);
  await Promise.all(peers.map((url) => syncPeer(url)));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  localClients.add(res);
  res.write(`data: ${JSON.stringify(store.getVisible())}\n\n`);
  req.on('close', () => localClients.delete(res));
});

app.get('/api/data', (req, res) => res.json(store.getVisible()));

app.post('/api/data', (req, res, next) => {
  try {
    const { key, value } = req.body || {};
    if (typeof key !== 'string' || !key.trim() || key.length > 200) {
      return res.status(400).json({ error: 'Key must be 1–200 characters.' });
    }
    if (!Object.prototype.hasOwnProperty.call(req.body, 'value')) {
      return res.status(400).json({ error: 'Value is required.' });
    }
    store.set(key.trim(), value, config.nodeId);
    sendLocalUpdate();
    void syncAllPeers();
    res.json({ ok: true, ...store.getVisible() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/data/:key', (req, res, next) => {
  try {
    store.delete(req.params.key, config.nodeId);
    sendLocalUpdate();
    void syncAllPeers();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/node', (req, res) => {
  res.json({
    nodeId: config.nodeId,
    port,
    addresses: reachableAddresses,
    peers: publicPeers(),
    registeredHosts: remoteDesktop.getRegisteredHosts(),
    isHub,
    hubUrl: isHub ? null : (process.env.HUB_URL || null)
  });
});

app.post('/api/peers', (req, res, next) => {
  try {
    const url = validatePeerAddress(req.body?.address);
    if (config.peers.includes(url)) {
      return res.status(409).json({ error: 'This peer is already added.' });
    }
    config.peers.push(url);
    saveConfig();
    void syncPeer(url);
    res.status(201).json({ peers: publicPeers() });
  } catch (error) {
    if (error.status) return next(error);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/peers', (req, res, next) => {
  try {
    const url = normalizePeerAddress(req.body?.address);
    config.peers = config.peers.filter((peer) => peer !== url);
    peerStates.delete(url);
    saveConfig();
    res.json({ peers: publicPeers() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/sync', (req, res, next) => {
  try {
    const changed = processPacket(req.body, null);
    res.json({ ok: true, changed, payload: store.getAll() });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.originalUrl}` });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error instanceof SyntaxError ? 400 : 500);
  if (status >= 500) console.error('[HTTP] Request failed:', error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : error.message });
});

function listenOnAddress(address) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    remoteDesktop.attach(server);
    server.once('error', (error) => {
      console.error(`[HTTP] Could not listen on ${address}:${port}:`, error.message);
      reject(error);
    });
    server.listen(port, address, () => {
      const host = address.includes(':') ? `[${address}]` : address;
      console.log(`${config.nodeId} listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}

async function start() {
  if (process.env.HOST) {
    await listenOnAddress(process.env.HOST.trim());
  } else if (process.env.BIND_ADDRESSES) {
    const addresses = [...new Set(process.env.BIND_ADDRESSES.split(',').map((v) => v.trim()).filter(Boolean))]
      .filter((addr) => isIP(addr) && !isLinkLocal(addr));
    if (!addresses.length) addresses.push('0.0.0.0');
    const results = await Promise.allSettled(addresses.map(listenOnAddress));
    const listening = results.filter((r) => r.status === 'fulfilled').length;
    if (!listening) throw new Error('SConnect could not listen on any configured network address.');
  } else {
    // Default: bind to 0.0.0.0 to safely accept connections on all interfaces
    await listenOnAddress('0.0.0.0');
    reachableAddresses.forEach((addr) => {
      const host = addr.includes(':') ? `[${addr}]` : addr;
      console.log(`  -> Reachable at http://${host}:${port}`);
    });
  }

  console.log(`Syncing with ${config.peers.length} configured peer(s).`);
  void syncAllPeers();
  setInterval(() => void syncAllPeers(), syncIntervalMs);
}

start().catch((error) => {
  console.error('[STARTUP]', error.message);
  process.exitCode = 1;
});
