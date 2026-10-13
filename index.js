require('dotenv').config();
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

const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const bindAddresses = getBindAddresses();
config.peers = Array.isArray(config.peers) ? config.peers : [];
if (!config.nodeId) {
  config.nodeId = `node-${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
  saveConfig();
}

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const localClients = new Set();
const peerStates = new Map();
const remoteDesktop = createRemoteDesktop(config.nodeId);
const syncIntervalMs = 5000;

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

function getBindAddresses() {
  if (process.env.BIND_ADDRESSES) {
    const addresses = [...new Set(process.env.BIND_ADDRESSES.split(',').map((value) => value.trim()).filter(Boolean))];
    if (!addresses.length || addresses.some((address) => !isIP(address) || !isPrivateAddress(address))) {
      throw new Error('BIND_ADDRESSES must contain only this system’s private, VPN, or loopback IP addresses.');
    }
    return addresses;
  }

  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (isIP(entry.address) && isPrivateAddress(entry.address)) addresses.add(entry.address);
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

function normalizePeerAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw new Error('Enter a peer IP address.');
  }

  let input = address.trim();
  if (!/^https?:\/\//i.test(input)) input = `http://${input}`;

  let peer;
  try {
    peer = new URL(input);
  } catch {
    throw new Error('Enter an IP address with an optional port, such as 192.168.1.20:3000.');
  }

  if (!['http:', 'https:'].includes(peer.protocol) ||
      !isIP(peer.hostname.replace(/^\[|\]$/g, '')) ||
      peer.username || peer.password ||
      (peer.pathname !== '/' && peer.pathname !== '') ||
      peer.search || peer.hash) {
    throw new Error('Peers must be an IP address with an optional port, not a URL path.');
  }

  if (!peer.port) peer.port = String(port);
  return `${peer.protocol}//${peer.host}`;
}

function validatePeerAddress(address) {
  const normalized = normalizePeerAddress(address);
  const peer = new URL(normalized);
  const host = peer.hostname.replace(/^\[|\]$/g, '');
  if (peer.port === String(port) &&
      (host === '127.0.0.1' || host === '::1')) {
    throw new Error('This address points back to this app.');
  }
  return normalized;
}

function publicPeers() {
  return config.peers.map((url) => ({
    address: new URL(url).host,
    status: peerStates.get(url)?.status || 'checking',
    lastSeen: peerStates.get(url)?.lastSeen || null,
    error: peerStates.get(url)?.error || null
  }));
}

function sendLocalUpdate() {
  const message = `data: ${JSON.stringify(store.getVisible())}\n\n`;
  for (const client of localClients) client.write(message);
}

async function syncPeer(url) {
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
        ? 'Connection timed out'
        : 'Could not connect';
    const previous = peerStates.get(url);
    peerStates.set(url, { status: 'offline', lastSeen: previous?.lastSeen || null, error: message });
    if (previous?.status !== 'offline' || previous?.error !== message) {
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
    addresses: bindAddresses,
    peers: publicPeers()
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
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.on('error', (error) => console.error(`[HTTP] Listener ${address} failed:`, error));
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });
}

async function start() {
  const results = await Promise.allSettled(bindAddresses.map(listenOnAddress));
  const listening = results.filter((result) => result.status === 'fulfilled').length;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const host = bindAddresses[index].includes(':') ? `[${bindAddresses[index]}]` : bindAddresses[index];
      console.log(`${config.nodeId} listening on http://${host}:${port}`);
    } else {
      console.error(`[HTTP] Could not listen on ${bindAddresses[index]}:${port}: ${result.reason.message}`);
    }
  });
  if (!listening) throw new Error('SConnect could not listen on any configured network address.');

  console.log(`Syncing with ${config.peers.length} configured peer(s).`);
  void syncAllPeers();
  setInterval(() => void syncAllPeers(), syncIntervalMs);
}

start().catch((error) => {
  console.error('[STARTUP]', error.message);
  process.exitCode = 1;
});
