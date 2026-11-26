// A stand-in for FleetHub's POS API (~/fleethub src/app/api/pos) for the
// tests: same routes, rules and answers, state in memory. Only SKUs a test
// registers are tracked, so every other rental stays ungated.
// Test controls: POST /__mock/units { units: [{ unitNumber, sku, name? }] }
// (each starts available, checklist passed), POST /__mock/units/:n/checklist
// (passes it again), POST /__mock/down { down } (answer 503), GET /__mock/state.
const http = require('http');

function startMockFleetHub(port, key) {
  const units = new Map(); // unitNumber → { unitNumber, sku, name, status, odometer, meterHours }
  const rentals = new Map(); // posRef → { posRef, unitNumber, status }
  let down = false;

  const readiness = u => {
    if (u.status === 'rented') return { ready: false, reasons: ['Unit is rented'] };
    if (u.status !== 'available') return { ready: false, reasons: ['Pre-rental checklist not completed since last return'] };
    return { ready: true, checklistId: 1 };
  };
  const view = u => ({ unitNumber: u.unitNumber, name: u.name, status: u.status, ...readiness(u) });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const url = new URL(req.url, 'http://x');
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch (e) {}

      if (url.pathname === '/__mock/units' && req.method === 'POST') {
        for (const u of data.units || []) units.set(u.unitNumber, { name: u.unitNumber, ...u, status: u.status || 'available' });
        return send(200, { ok: true });
      }
      const cl = url.pathname.match(/^\/__mock\/units\/(.+)\/checklist$/);
      if (cl) { const u = units.get(decodeURIComponent(cl[1])); if (u) u.status = 'available'; return send(u ? 200 : 404, { ok: !!u }); }
      if (url.pathname === '/__mock/down') { down = !!data.down; return send(200, { down }); }
      if (url.pathname === '/__mock/state') return send(200, { units: [...units.values()], rentals: [...rentals.values()] });

      if (down) return send(503, { error: 'Service unavailable' });
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: 'Unauthorized' });

      if (url.pathname === '/api/pos/units' && req.method === 'GET') {
        const sku = url.searchParams.get('sku');
        return send(200, { sku, units: [...units.values()].filter(u => u.sku === sku).sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)).map(view) });
      }
      if (url.pathname === '/api/pos/rentals/checkout' && req.method === 'POST') {
        const u = units.get(data.unitNumber);
        if (!u) return send(404, { error: 'Unit not found' });
        const existing = rentals.get(data.posRef);
        if (existing && existing.unitNumber !== u.unitNumber) return send(409, { error: 'posRef already used for a different unit' });
        if (existing && existing.status === 'active') return send(200, { rental: existing });
        if (existing && existing.status === 'returned') return send(409, { error: 'posRef belongs to a rental that was already returned' });
        const r = readiness(u);
        if (!r.ready) return send(409, { error: 'Unit is not ready for rental', details: r.reasons });
        u.status = 'rented';
        const rental = { posRef: data.posRef, unitNumber: u.unitNumber, status: 'active' };
        rentals.set(data.posRef, rental);
        return send(200, { rental });
      }
      if (url.pathname === '/api/pos/rentals/cancel' && req.method === 'POST') {
        const r = rentals.get(data.posRef);
        if (!r) return send(404, { error: 'Rental not found' });
        if (r.status === 'cancelled') return send(200, { rental: r });
        if (r.status !== 'active') return send(409, { error: `Rental is ${r.status}; only active rentals can be cancelled` });
        r.status = 'cancelled';
        const u = units.get(r.unitNumber);
        if (u.status === 'rented') u.status = 'available';
        return send(200, { rental: r });
      }
      if (url.pathname === '/api/pos/rentals/return' && req.method === 'POST') {
        const r = rentals.get(data.posRef);
        if (!r) return send(404, { error: 'Rental not found' });
        if (r.status !== 'returned') {
          r.status = 'returned';
          const u = units.get(r.unitNumber);
          u.status = 'needs_service';
          if (data.odometer !== undefined) u.odometer = data.odometer;
          if (data.meterHours !== undefined) u.meterHours = data.meterHours;
        }
        return send(200, { rental: r });
      }
      send(404, { error: 'Not found' });
    });
  });
  server.listen(port);
  return server;
}

module.exports = { startMockFleetHub };
