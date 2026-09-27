#!/usr/bin/env node
'use strict';

/**
 * Server 1 — Web UI + API gateway
 * - Serves the website
 * - Accepts deobf jobs from the browser
 * - Forwards work to Server 2 (Python worker) via WORKER_URL
 * - Receives callback from worker, verifies secret, then client polls result
 *
 * Env:
 *   PORT / SERVER_PORT
 *   WORKER_URL     e.g. https://your-worker.onrender.com
 *   SHARED_SECRET  same value on both servers
 *   PUBLIC_URL     this service's public URL (for worker callback), e.g. https://dd-5gqw.onrender.com
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3847);
const WEB = path.join(__dirname, 'web');
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SHARED_SECRET = process.env.SHARED_SECRET || 'yoohub-dev-secret-change-me';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const JOB_TTL_MS = 45 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** @type {Map<string, object>} */
const jobs = new Map();

function send(res, status, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function purgeJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function newSession() {
  return {
    sessionId: crypto.randomBytes(12).toString('hex'),
    createdAt: Date.now(),
    workerConfigured: Boolean(WORKER_URL),
    workerUrl: WORKER_URL ? '(configured on server)' : null,
  };
}

async function forwardToWorker(job) {
  if (!WORKER_URL) {
    job.status = 'error';
    job.error = 'WORKER_URL is not set on Server 1. Deploy Python worker and set WORKER_URL + SHARED_SECRET + PUBLIC_URL.';
    job.updatedAt = Date.now();
    return;
  }
  const callbackUrl = (PUBLIC_URL || '') + '/api/callback';
  if (!PUBLIC_URL) {
    job.status = 'error';
    job.error = 'PUBLIC_URL is not set. Set it to this web service URL so the worker can callback.';
    job.updatedAt = Date.now();
    return;
  }

  const payload = JSON.stringify({
    job_id: job.id,
    source: job.source,
    options: job.options || {},
    callback_url: callbackUrl,
    secret: SHARED_SECRET,
  });

  try {
    const res = await fetch(WORKER_URL + '/work', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      job.status = 'error';
      job.error = 'Worker rejected job: HTTP ' + res.status + ' ' + (data.error || text).slice(0, 500);
      job.updatedAt = Date.now();
      return;
    }
    job.status = 'sent_to_worker';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = 'Cannot reach worker: ' + String(e.message || e);
    job.updatedAt = Date.now();
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB, safe);
  if (!filePath.startsWith(WEB)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = (req.url || '/').split('?')[0];

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Health + config for the web page (auto-fill, no secrets leaked)
  if (method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      role: 'web-gateway',
      workerConfigured: Boolean(WORKER_URL),
      publicUrlSet: Boolean(PUBLIC_URL),
      jobs: jobs.size,
      port: PORT,
    });
  }

  // New session each visit (optional, for future multi-tenant)
  if (method === 'GET' && url === '/api/session') {
    return sendJson(res, 200, newSession());
  }

  // Client submits work → Server 1 creates job → forwards to Server 2
  if (method === 'POST' && url === '/api/submit') {
    try {
      purgeJobs();
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const source = body.source || body.code || '';
      if (!source) return sendJson(res, 400, { error: 'Missing source' });
      const id = crypto.randomBytes(8).toString('hex');
      const job = {
        id,
        status: 'queued',
        source,
        options: body.options || {},
        output: null,
        log: '',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verified: false,
      };
      jobs.set(id, job);
      sendJson(res, 202, { ok: true, jobId: id, status: job.status, poll: '/api/job/' + id });
      // async forward
      setImmediate(() => forwardToWorker(job));
      return;
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  // Server 2 callbacks here with result
  if (method === 'POST' && url === '/api/callback') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      if (body.secret !== SHARED_SECRET) {
        return sendJson(res, 403, { error: 'Invalid secret' });
      }
      const job = jobs.get(body.job_id);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });

      // Verify / confirm result before exposing to client
      if (body.ok && typeof body.output === 'string') {
        job.status = 'done';
        job.output = body.output;
        job.log = body.log || '';
        job.error = null;
        job.verified = true;
      } else {
        job.status = 'error';
        job.error = body.error || 'Worker reported failure';
        job.log = body.log || job.error;
        job.verified = true;
      }
      job.updatedAt = Date.now();
      return sendJson(res, 200, { ok: true, received: true });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  // Client polls
  if (method === 'GET' && url.startsWith('/api/job/')) {
    const id = url.slice('/api/job/'.length).replace(/[^a-f0-9]/gi, '');
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Job not found' });
    // Only return output after verified callback
    return sendJson(res, 200, {
      id: job.id,
      status: job.status,
      verified: job.verified,
      output: job.verified && job.status === 'done' ? job.output : null,
      log: job.log || '',
      error: job.error,
    });
  }

  if (method === 'GET') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(
    `[web-gateway] :${PORT}\n` +
    `  WORKER_URL=${WORKER_URL || '(not set)'}\n` +
    `  PUBLIC_URL=${PUBLIC_URL || '(not set)'}\n`
  );
});
