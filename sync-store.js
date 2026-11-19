(() => {
  'use strict';

  const DATASETS = {
    drugs: {
      key: 'drugs',
      label: 'ทะเบียนยา (drugs_update.json)',
      fileName: 'drugs_update.json',
      path: './data/drugs_update.json',
      primaryKey: 'sku',
      requiredKeys: ['sku', 'generic_name']
    },
    stock: {
      key: 'stock',
      label: 'สต็อกรายล็อต (stock.json)',
      fileName: 'stock.json',
      path: './data/stock.json',
      primaryKey: 'stock_id',
      requiredKeys: ['stock_id', 'sku', 'lot']
    },
    dispense: {
      key: 'dispense',
      label: 'ประวัติการจ่ายยา (dispense-log.json)',
      fileName: 'dispense-log.json',
      path: './data/dispense-log.json',
      primaryKey: 'dispense_id',
      requiredKeys: ['dispense_id', 'datetime', 'sku']
    }
  };

  const PREFIX = 'pharmacy_sync_v1_';
  const OVERRIDE_KEY = (ds) => `${PREFIX}override_${ds}`;
  const HISTORY_KEY = `${PREFIX}history`;
  const AUTOSYNC_KEY = `${PREFIX}autosync_sec`;
  const CHANNEL_NAME = 'pharmacy-json-sync';

  const listeners = new Set();
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

  let dirHandle = null;
  let autoSyncTimer = null;
  let lastBundle = null;

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function safeParseStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function safeSetStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore quota errors cleanly
    }
  }

  function appendHistory(entry) {
    const list = safeParseStorage(HISTORY_KEY, []);
    list.unshift({ ...entry, ts: new Date().toISOString() });
    safeSetStorage(HISTORY_KEY, list.slice(0, 20));
  }

  function getHistory() {
    return safeParseStorage(HISTORY_KEY, []);
  }

  function detectDataset(jsonObj) {
    const items = Array.isArray(jsonObj) ? jsonObj : jsonObj?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const sample = items[0] || {};
    if ('dispense_id' in sample || 'pharmacist_code' in sample) return 'dispense';
    if ('stock_id' in sample || 'qty_on_hand' in sample) return 'stock';
    if ('generic_name' in sample || 'atc_code' in sample || 'reorder_level' in sample) return 'drugs';
    return null;
  }

  function normalizePayload(datasetKey, incoming, currentData) {
    const baseMeta = currentData?.meta ? { ...currentData.meta } : {};
    if (Array.isArray(incoming)) {
      return { meta: baseMeta, items: incoming };
    }
    if (incoming && typeof incoming === 'object' && Array.isArray(incoming.items)) {
      return {
        meta: { ...baseMeta, ...(incoming.meta && typeof incoming.meta === 'object' ? incoming.meta : {}) },
        items: incoming.items
      };
    }
    return null;
  }

  function validateDataset(datasetKey, incoming, currentData = null) {
    const spec = DATASETS[datasetKey];
    if (!spec) {
      return { ok: false, errors: ['กรุณาเลือกชุดข้อมูลปลายทาง (drugs / stock / dispense)'], normalized: null };
    }
    const normalized = normalizePayload(datasetKey, incoming, currentData);
    if (!normalized) {
      return {
        ok: false,
        errors: ['JSON ต้องมีอาร์เรย์ items[] หรือเป็นอาร์เรย์รายการยาโดยตรง'],
        normalized: null
      };
    }
    const errors = [];
    normalized.items.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        errors.push(`รายการที่ ${idx + 1} ไม่ใช่ออบเจ็กต์ JSON`);
        return;
      }
      for (const reqKey of spec.requiredKeys) {
        if (item[reqKey] === undefined || item[reqKey] === null || String(item[reqKey]).trim() === '') {
          errors.push(`รายการที่ ${idx + 1} ขาดฟิลด์ "${reqKey}"`);
        }
      }
      if (datasetKey === 'stock' && item.qty_on_hand !== undefined && Number.isNaN(Number(item.qty_on_hand))) {
        errors.push(`รายการ ${item.stock_id || idx + 1} มี qty_on_hand ไม่ใช่ตัวเลข`);
      }
      if (datasetKey === 'dispense' && item.qty !== undefined && Number.isNaN(Number(item.qty))) {
        errors.push(`รายการ ${item.dispense_id || idx + 1} มี qty ไม่ใช่ตัวเลข`);
      }
    });
    return {
      ok: errors.length === 0,
      errors: errors.slice(0, 8),
      normalized
    };
  }

  function computeDiff(datasetKey, currentData, incomingPayload, mode = 'merge') {
    const spec = DATASETS[datasetKey];
    const pk = spec.primaryKey;
    const oldItems = Array.isArray(currentData?.items) ? currentData.items : [];
    const newItems = Array.isArray(incomingPayload?.items) ? incomingPayload.items : [];

    if (mode === 'replace') {
      const merged = {
        meta: { ...(incomingPayload.meta || {}) },
        items: newItems.map((x) => ({ ...x }))
      };
      if (datasetKey === 'drugs') merged.meta.count = merged.items.length;
      return {
        merged,
        added: newItems.length,
        updated: 0,
        unchanged: 0,
        removed: oldItems.length,
        total: merged.items.length
      };
    }

    const oldMap = new Map(oldItems.map((it) => [String(it[pk]), it]));
    const order = oldItems.map((it) => String(it[pk]));
    let added = 0;
    let updated = 0;

    for (const item of newItems) {
      const id = String(item[pk]);
      const prev = oldMap.get(id);
      if (!prev) {
        added++;
        oldMap.set(id, { ...item });
        order.push(id);
      } else {
        const nextItem = { ...prev, ...item };
        if (JSON.stringify(prev) !== JSON.stringify(nextItem)) {
          updated++;
        }
        oldMap.set(id, nextItem);
      }
    }

    const mergedItems = order.map((id) => oldMap.get(id));
    const mergedMeta = {
      ...(currentData?.meta || {}),
      ...(incomingPayload?.meta || {}),
      updated: new Date().toISOString().slice(0, 10)
    };
    if (datasetKey === 'drugs') mergedMeta.count = mergedItems.length;

    return {
      merged: { meta: mergedMeta, items: mergedItems },
      added,
      updated,
      unchanged: Math.max(0, oldItems.length - updated),
      removed: 0,
      total: mergedItems.length
    };
  }

  async function checkDiskApi() {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!isLocalHost) return { writable: false, files: {} };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch('/api/sync/status', {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!res.ok) return { writable: false, files: {} };
      return await res.json();
    } catch {
      return { writable: false, files: {} };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDiskDataset(datasetKey) {
    const spec = DATASETS[datasetKey];
    const url = `${spec.path}?t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${spec.path}: HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data?.items)) {
      throw new Error(`ข้อมูล items[] ไม่ถูกต้องใน ${spec.path}`);
    }
    return {
      data,
      diskHash: hashString(text)
    };
  }

  async function loadAll({ forceDisk = false } = {}) {
    const [apiStatus, drugsDisk, stockDisk, dispenseDisk] = await Promise.all([
      checkDiskApi(),
      fetchDiskDataset('drugs'),
      fetchDiskDataset('stock'),
      fetchDiskDataset('dispense')
    ]);

    const diskResults = {
      drugs: drugsDisk,
      stock: stockDisk,
      dispense: dispenseDisk
    };

    const result = {};
    const overrideDatasets = [];
    const diskHashes = {};

    for (const key of Object.keys(DATASETS)) {
      const disk = diskResults[key];
      diskHashes[key] = disk.diskHash;
      const override = safeParseStorage(OVERRIDE_KEY(key), null);

      if (!forceDisk && override && override.payload && override.diskHash === disk.diskHash) {
        result[key] = override.payload;
        overrideDatasets.push(key);
      } else {
        if (override && override.diskHash !== disk.diskHash) {
          localStorage.removeItem(OVERRIDE_KEY(key));
        }
        result[key] = disk.data;
      }
    }

    const mode = apiStatus.writable
      ? 'disk-api'
      : dirHandle
        ? 'fs-access'
        : overrideDatasets.length
          ? 'browser-store'
          : 'disk-readonly';

    lastBundle = {
      drugs: result.drugs,
      stock: result.stock,
      dispense: result.dispense,
      syncMeta: {
        mode,
        diskWritable: Boolean(apiStatus.writable),
        dirConnected: Boolean(dirHandle),
        diskHashes,
        overrideDatasets,
        lastSyncAt: new Date().toISOString(),
        history: getHistory()
      }
    };

    return lastBundle;
  }

  async function writeWithFsHandle(datasetKey, payload) {
    if (!dirHandle) return false;
    const spec = DATASETS[datasetKey];
    const fileHandle = await dirHandle.getFileHandle(spec.fileName, { create: false });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2) + '\n');
    await writable.close();
    return true;
  }

  async function applyUpdate(datasetKey, incomingPayload, mode = 'merge', sourceLabel = 'manual-json') {
    if (!lastBundle) await loadAll();
    const currentData = lastBundle[datasetKey];
    const validation = validateDataset(datasetKey, incomingPayload, currentData);
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }

    const diff = computeDiff(datasetKey, currentData, validation.normalized, mode);
    const mergedPayload = diff.merged;

    let persistedTo = 'browser-store';
    const apiStatus = await checkDiskApi();

    if (apiStatus.writable) {
      const res = await fetch(`/api/sync/${datasetKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergedPayload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error || `บันทึกไฟล์ ${datasetKey} ล้มเหลว`);
      }
      localStorage.removeItem(OVERRIDE_KEY(datasetKey));
      persistedTo = 'disk-api';
    } else if (dirHandle) {
      await writeWithFsHandle(datasetKey, mergedPayload);
      localStorage.removeItem(OVERRIDE_KEY(datasetKey));
      persistedTo = 'fs-access';
    } else {
      safeSetStorage(OVERRIDE_KEY(datasetKey), {
        payload: mergedPayload,
        diskHash: lastBundle.syncMeta.diskHashes[datasetKey],
        updatedAt: new Date().toISOString(),
        mode,
        sourceLabel
      });
    }

    appendHistory({
      dataset: datasetKey,
      mode,
      sourceLabel,
      persistedTo,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      total: diff.total
    });

    const freshBundle = await loadAll({ forceDisk: persistedTo !== 'browser-store' });
    const eventDetail = {
      type: 'sync-updated',
      dataset: datasetKey,
      persistedTo,
      diff,
      bundle: freshBundle
    };

    if (channel) {
      channel.postMessage({ type: 'sync-updated', dataset: datasetKey, ts: Date.now() });
    }
    notify(eventDetail);
    return eventDetail;
  }

  async function syncFromDisk() {
    const prevHashes = lastBundle?.syncMeta?.diskHashes ? { ...lastBundle.syncMeta.diskHashes } : null;
    const prevCounts = lastBundle
      ? {
          drugs: lastBundle.drugs.items.length,
          stock: lastBundle.stock.items.length,
          dispense: lastBundle.dispense.items.length
        }
      : null;

    const fresh = await loadAll({ forceDisk: false });
    const changed = [];
    if (prevHashes) {
      for (const k of Object.keys(DATASETS)) {
        if (prevHashes[k] !== fresh.syncMeta.diskHashes[k]) changed.push(k);
      }
    }

    if (changed.length > 0) {
      appendHistory({
        dataset: changed.join(', '),
        mode: 'disk-sync',
        sourceLabel: 'disk-refresh',
        persistedTo: fresh.syncMeta.mode,
        added: 0,
        updated: 0,
        removed: 0,
        total: fresh[changed[0]].items.length
      });
      fresh.syncMeta.history = getHistory();
    }

    const detail = {
      type: 'disk-synced',
      changed,
      prevCounts,
      bundle: fresh
    };
    notify(detail);
    return detail;
  }

  async function resetToDiskFiles() {
    for (const k of Object.keys(DATASETS)) {
      localStorage.removeItem(OVERRIDE_KEY(k));
    }
    appendHistory({
      dataset: 'all',
      mode: 'reset',
      sourceLabel: 'restore-disk',
      persistedTo: 'disk-files',
      added: 0,
      updated: 0,
      removed: 0,
      total: 0
    });
    const fresh = await loadAll({ forceDisk: true });
    if (channel) {
      channel.postMessage({ type: 'sync-reset', ts: Date.now() });
    }
    const detail = { type: 'sync-reset', bundle: fresh };
    notify(detail);
    return detail;
  }

  async function connectDataDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      return { supported: false, message: 'เบราว์เซอร์นี้ไม่รองรับ File System Access API (รองรับใน Chrome/Edge)' };
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      // Verify at least one target JSON file exists in the chosen directory
      await handle.getFileHandle('stock.json', { create: false });
      dirHandle = handle;
      const fresh = await loadAll();
      notify({ type: 'dir-connected', bundle: fresh });
      return { supported: true, connected: true, name: handle.name };
    } catch (err) {
      if (err.name === 'AbortError') return { supported: true, connected: false, cancelled: true };
      return {
        supported: true,
        connected: false,
        message: 'กรุณาเลือกโฟลเดอร์ data/ ที่มีไฟล์ stock.json และ drugs_update.json'
      };
    }
  }

  function exportDatasetJson(datasetKey, bundle = lastBundle) {
    const spec = DATASETS[datasetKey];
    if (!spec || !bundle?.[datasetKey]) return;
    const text = JSON.stringify(bundle[datasetKey], null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = spec.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function getAutoSync() {
    return Number(safeParseStorage(AUTOSYNC_KEY, 0)) || 0;
  }

  function setAutoSync(seconds) {
    const sec = Number(seconds) || 0;
    safeSetStorage(AUTOSYNC_KEY, sec);
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    if (sec > 0) {
      autoSyncTimer = setInterval(() => {
        syncFromDisk().catch(() => {});
      }, sec * 1000);
    }
    return sec;
  }

  function notify(detail) {
    listeners.forEach((fn) => {
      try {
        fn(detail);
      } catch {
        // Isolate subscriber errors
      }
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  if (channel) {
    channel.addEventListener('message', async () => {
      try {
        const bundle = await loadAll();
        notify({ type: 'cross-tab-sync', bundle });
      } catch {
        // ignore
      }
    });
  }

  window.addEventListener('storage', async (e) => {
    if (e.key && e.key.startsWith(PREFIX)) {
      try {
        const bundle = await loadAll();
        notify({ type: 'cross-tab-sync', bundle });
      } catch {
        // ignore
      }
    }
  });

  // Start auto-sync if previously enabled
  const savedAuto = getAutoSync();
  if (savedAuto > 0) setAutoSync(savedAuto);

  window.PharmacySync = {
    DATASETS,
    loadAll,
    detectDataset,
    validateDataset,
    computeDiff,
    applyUpdate,
    syncFromDisk,
    resetToDiskFiles,
    connectDataDirectory,
    exportDatasetJson,
    getAutoSync,
    setAutoSync,
    getHistory,
    subscribe,
    getCurrentBundle: () => lastBundle
  };
})();
