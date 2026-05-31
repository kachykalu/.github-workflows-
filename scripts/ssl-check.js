'use strict';
const tls = require('tls');

// Hosts come from the Worker's /api/ssl/hosts endpoint (all tenants). Empty
// fallback so nothing is hardcoded — a token problem shows as "0 hosts".
const DEFAULT_HOSTS = [];

const SSL_WARN_DAYS = 30;
const SSL_CRIT_DAYS = 7;

function sslHostFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
    return url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

async function loadHosts(workerUrl, token) {
  try {
    const res = await fetch(`${workerUrl}/api/ssl/hosts`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.hosts || []);
    const hosts = Array.from(new Set(
      list.map(h => h.host || sslHostFromUrl(h.url)).filter(Boolean)
    ));
    return hosts.length ? hosts : DEFAULT_HOSTS;
  } catch (e) {
    console.warn(`Could not load dynamic app hosts (${e.message}); using defaults.`);
    return DEFAULT_HOSTS;
  }
}

function checkHost(host) {
  const hostname = host.split(':')[0];
  const port     = host.includes(':') ? parseInt(host.split(':').pop(), 10) : 443;
  const out      = { host, valid: false, issuer: '—', subject: '—', expires: '—', daysLeft: null, state: 'unknown', error: null };

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sock?.destroy();
      out.error = 'Timed out'; out.state = 'err';
      resolve(out);
    }, 12000);

    let sock;
    try {
      sock = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
        clearTimeout(timer);
        const cert = sock.getPeerCertificate();
        sock.destroy();
        if (!cert?.valid_to) { out.error = 'No cert data'; out.state = 'err'; return resolve(out); }
        const expiry = new Date(cert.valid_to);
        const now    = new Date();
        out.valid    = true;
        out.subject  = cert.subject?.CN || '—';
        out.issuer   = cert.issuer?.CN  || cert.issuer?.O || '—';
        out.expires  = expiry.toISOString().slice(0, 10);
        out.daysLeft = Math.floor((expiry - now) / 86400000);
        out.state    = out.daysLeft <= SSL_CRIT_DAYS ? 'critical' : out.daysLeft <= SSL_WARN_DAYS ? 'warn' : 'ok';
        resolve(out);
      });
      sock.on('error', e => { clearTimeout(timer); out.error = e.message.slice(0, 80); out.state = 'err'; resolve(out); });
    } catch (e) {
      clearTimeout(timer); out.error = e.message.slice(0, 80); out.state = 'err'; resolve(out);
    }
  });
}

async function main() {
  const workerUrl = process.env.WORKER_URL;
  const token     = process.env.SSL_INGEST_TOKEN;
  if (!workerUrl || !token) { console.error('Missing WORKER_URL or SSL_INGEST_TOKEN'); process.exit(1); }

  const hosts = await loadHosts(workerUrl, token);
  console.log(`Checking ${hosts.length} hosts...\n`);
  const results = await Promise.all(hosts.map(checkHost));
  for (const r of results) {
    const icon = r.state === 'ok' ? '✅' : r.state === 'warn' ? '⚠️ ' : r.state === 'critical' ? '🔴' : '❌';
    console.log(`${icon}  ${r.host.padEnd(40)} ${r.daysLeft !== null ? r.daysLeft + 'd' : r.error}`);
  }

  console.log('\nPosting results to worker...');
  const res = await fetch(`${workerUrl}/api/ssl/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(results),
  });
  if (!res.ok) { console.error(`Worker rejected the payload: ${res.status} ${await res.text()}`); process.exit(1); }
  const body = await res.json();
  console.log(`Done — ${body.count} results stored.`);
}

main().catch(e => { console.error(e); process.exit(1); });
