'use strict';
// Real per-phase latency probe. Workers' fetch() can't expose socket timings,
// so this measures DNS/TCP/TLS/TTFB/transfer per host via http(s) socket events
// and posts them to /api/apm/ingest. Dependency-free (Node 20 global fetch).
const https = require('https');
const http  = require('http');
const TIMEOUT_MS = 15000;

function measure(item) {
  return new Promise(resolve => {
    const out = { host: item.host, name: item.name, dns: null, tcp: null, tls: null, ttfb: null, transfer: null, total: null, status: null, error: null, measuredAt: new Date().toISOString() };
    let url;
    try { url = new URL(item.url); } catch { out.error = 'bad url'; return resolve(out); }
    const mod = url.protocol === 'http:' ? http : https;
    const start = process.hrtime.bigint();
    const ts = {};
    const ms = (a, b) => Math.max(0, Math.round(Number(b - a) / 1e6));
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      const afterDns = ts.lookup || start, afterTcp = ts.connect || afterDns, afterTls = ts.secure || afterTcp;
      if (ts.lookup)              out.dns      = ms(start, ts.lookup);
      if (ts.connect)             out.tcp      = ms(afterDns, ts.connect);
      if (ts.secure)              out.tls      = ms(afterTcp, ts.secure);
      if (ts.respStart)           out.ttfb     = ms(afterTls, ts.respStart);
      if (ts.respStart && ts.end) out.transfer = ms(ts.respStart, ts.end);
      if (ts.end)                 out.total    = ms(start, ts.end);
      resolve(out);
    };
    const req = mod.request(url, { method: 'GET', agent: false, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'OASIS-APM/1.0', 'Accept': '*/*' } }, res => {
      out.status = res.statusCode;
      ts.respStart = process.hrtime.bigint();
      res.on('data', () => {});
      res.on('end',  () => { ts.end = process.hrtime.bigint(); done(); });
      res.on('error', () => { ts.end = process.hrtime.bigint(); done(); });
    });
    req.on('socket', s => {
      s.on('lookup',        () => { ts.lookup  = process.hrtime.bigint(); });
      s.on('connect',       () => { ts.connect = process.hrtime.bigint(); });
      s.on('secureConnect', () => { ts.secure  = process.hrtime.bigint(); });
    });
    req.on('timeout', () => { out.error = 'timeout'; req.destroy(); });
    req.on('error', e => { if (!out.error) out.error = (e.message || 'request failed').slice(0, 80); ts.end = ts.end || process.hrtime.bigint(); done(); });
    req.end();
  });
}

async function main() {
  const workerUrl = process.env.WORKER_URL, token = process.env.SSL_INGEST_TOKEN;
  if (!workerUrl || !token) { console.error('Missing WORKER_URL or SSL_INGEST_TOKEN'); process.exit(1); }
  const res = await fetch(`${workerUrl}/api/ssl/hosts`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`hosts fetch failed: ${res.status}`); process.exit(1); }
  const items = ((await res.json()).hosts || []).filter(h => h.url);
  console.log(`Measuring ${items.length} hosts...\n`);
  const results = await Promise.all(items.map(measure));
  for (const r of results) console.log(`${String(r.host || '').padEnd(42)} ${r.error ? 'ERR ' + r.error : `dns ${r.dns} tcp ${r.tcp} tls ${r.tls} ttfb ${r.ttfb} xfer ${r.transfer} = ${r.total}ms`}`);
  const post = await fetch(`${workerUrl}/api/apm/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(results) });
  if (!post.ok) { console.error(`ingest failed: ${post.status} ${await post.text()}`); process.exit(1); }
  console.log(`\nDone — ${(await post.json()).count} measurements stored.`);
}
main().catch(e => { console.error(e); process.exit(1); });
