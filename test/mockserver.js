'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

// mode: opts.wrongPassword / opts.malformedLogin / opts.nonJson toggle failure scenarios.
function startMockServer(port, opts) {
  opts = opts || {};
  const zones = opts.zones || [
    { uid: 1, name: 'Front Grass', active: true, state: 0, remaining: 0 },
    { uid: 2, name: 'Driveway', active: true, state: 1, remaining: 120 },
    { uid: 3, name: 'Old Zone', active: false, state: 0, remaining: 0 },
  ];
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, 'fixtures', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem')),
    },
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url.startsWith('/api/4/auth/login')) {
          if (opts.wrongPassword) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid password' }));
            return;
          }
          if (opts.malformedLogin) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({})); // no access_token
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }));
          return;
        }
        if (req.url.startsWith('/api/4/zone/') && req.url.includes('/start')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 0 }));
          return;
        }
        if (req.url.startsWith('/api/4/zone/') && req.url.includes('/stop')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 0 }));
          return;
        }
        if (req.url.startsWith('/api/4/zone')) {
          if (opts.nonJson) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>not json</html>');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ zones }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    }
  );
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { startMockServer };
