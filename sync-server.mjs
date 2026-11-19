import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const DATASETS = {
  drugs: {
    relPath: 'data/drugs_update.json',
    requiredKeys: ['sku', 'generic_name']
  },
  stock: {
    relPath: 'data/stock.json',
    requiredKeys: ['stock_id', 'sku', 'lot']
  },
  dispense: {
    relPath: 'data/dispense-log.json',
    requiredKeys: ['dispense_id', 'datetime', 'sku']
  }
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function validatePayload(datasetKey, payload) {
  const spec = DATASETS[datasetKey];
  if (!spec) return 'ไม่รู้จักชุดข้อมูลนี้';
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    return 'โครงสร้าง JSON ต้องเป็นออบเจ็กต์ที่มี items[]';
  }
  for (let i = 0; i < payload.items.length; i++) {
    const item = payload.items[i];
    if (!item || typeof item !== 'object') {
      return `รายการที่ ${i + 1} ไม่ใช่ออบเจ็กต์`;
    }
    for (const k of spec.requiredKeys) {
      if (item[k] === undefined || item[k] === null || String(item[k]).trim() === '') {
        return `รายการที่ ${i + 1} ขาดฟิลด์สำคัญ "${k}"`;
      }
    }
  }
  return null;
}

function getSyncStatus() {
  const files = {};
  for (const [key, spec] of Object.entries(DATASETS)) {
    const fullPath = path.join(ROOT, spec.relPath);
    try {
      const stat = fs.statSync(fullPath);
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      files[key] = {
        path: spec.relPath,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        count: Array.isArray(parsed.items) ? parsed.items.length : 0,
        meta: parsed.meta || {}
      };
    } catch (err) {
      files[key] = {
        path: spec.relPath,
        error: err.message
      };
    }
  }
  return {
    writable: true,
    serverTime: new Date().toISOString(),
    files
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('ไฟล์ JSON ใหญ่เกินขีดจำกัด 10 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('รูปแบบ JSON ไม่ถูกต้อง'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/sync/status') {
      sendJson(res, 200, getSyncStatus());
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/sync/')) {
      const datasetKey = pathname.slice('/api/sync/'.length);
      if (!Object.hasOwn(DATASETS, datasetKey)) {
        sendJson(res, 404, { ok: false, error: 'Unknown dataset' });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      const validationError = validatePayload(datasetKey, payload);
      if (validationError) {
        sendJson(res, 400, { ok: false, error: validationError });
        return;
      }

      const targetPath = path.join(ROOT, DATASETS[datasetKey].relPath);
      const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
      const formatted = JSON.stringify(payload, null, 2) + '\n';
      fs.writeFileSync(tmpPath, formatted, 'utf8');
      fs.renameSync(tmpPath, targetPath);

      sendJson(res, 200, {
        ok: true,
        dataset: datasetKey,
        path: DATASETS[datasetKey].relPath,
        count: payload.items.length,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, rel);
    if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let filePath = resolved;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pharmacy Sync Server running at http://localhost:${PORT}/`);
});
