import http from 'node:http';

export async function startWorkerStatus(port, snapshot) {
  let ready = true;
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method !== 'GET' || !['/health', '/diagnostics'].includes(path)) {
      res.writeHead(404); res.end(); return;
    }
    const state = snapshot();
    const ok = ready && state.connected;
    res.writeHead(path === '/health' && !ok ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(path === '/health' ? { ok, service: 'max-bot-worker', transport: 'rabbitmq' } : state));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return { async stop() {
    ready = false;
    await new Promise(resolve => server.close(resolve));
  } };
}
