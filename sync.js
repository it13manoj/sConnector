const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

class SyncStore {
  constructor() {
    this.data = this.load();
    this.clock = Object.values(this.data).reduce(
      (latest, item) => Math.max(latest, item.updatedAt || 0),
      0
    );
  }

  load() {
    if (!fs.existsSync(DATA_FILE)) return Object.create(null);
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid data store format in ${DATA_FILE}`);
    }
    const records = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) records[key] = value;
    return records;
  }

  save() {
    const temporaryFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(temporaryFile, DATA_FILE);
  }

  nextTimestamp() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  isValidRemoteData(remoteData) {
    if (!remoteData || typeof remoteData !== 'object' || Array.isArray(remoteData)) return false;
    return Object.entries(remoteData).every(([key, item]) =>
      key.length > 0 && key.length <= 200 &&
      item && typeof item === 'object' && !Array.isArray(item) &&
      Number.isFinite(item.updatedAt) && item.updatedAt >= 0 &&
      (item.updatedBy === undefined || typeof item.updatedBy === 'string') &&
      (item.deleted === undefined || typeof item.deleted === 'boolean') &&
      (item.deleted === true || Object.prototype.hasOwnProperty.call(item, 'value'))
    );
  }

  isNewer(candidate, current) {
    if (!current) return true;
    if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
    return (candidate.updatedBy || '').localeCompare(current.updatedBy || '') > 0;
  }

  merge(remoteData) {
    if (!this.isValidRemoteData(remoteData)) {
      const error = new Error('Sync data must be a map of timestamped records.');
      error.status = 400;
      throw error;
    }

    let changed = false;
    for (const [key, remoteItem] of Object.entries(remoteData)) {
      const candidate = {
        ...remoteItem,
        updatedBy: remoteItem.updatedBy || 'legacy-peer'
      };
      if (this.isNewer(candidate, this.data[key])) {
        this.data[key] = candidate;
        this.clock = Math.max(this.clock, candidate.updatedAt);
        changed = true;
      }
    }

    if (changed) this.save();
    return changed;
  }

  set(key, value, nodeId) {
    this.data[key] = {
      value,
      updatedAt: this.nextTimestamp(),
      updatedBy: nodeId,
      deleted: false
    };
    this.save();
  }

  delete(key, nodeId) {
    this.data[key] = {
      updatedAt: this.nextTimestamp(),
      updatedBy: nodeId,
      deleted: true
    };
    this.save();
  }

  getAll() {
    return { data: this.data };
  }

  getVisible() {
    const visible = Object.create(null);
    for (const [key, item] of Object.entries(this.data)) {
      if (!item.deleted) visible[key] = item;
    }
    return { data: visible };
  }
}

module.exports = new SyncStore();
