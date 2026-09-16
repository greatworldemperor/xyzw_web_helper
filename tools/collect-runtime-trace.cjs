#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.argv[2] || 4174);
const outputPath = path.resolve(process.argv[3] || 'tools/7.7.12.runtime-trace.json');
const maxBodyBytes = 128 * 1024 * 1024;

function send(response, status, body) {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
  if (request.method !== 'POST' || request.url !== '/trace') return send(response, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.destroy(new Error('trace body too large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(value)}\n`, 'utf8');
      send(response, 200, { ok: true, outputPath, bytes: size, unique: value.unique, calls: value.calls });
    } catch (error) {
      send(response, 400, { ok: false, error: error.message });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ port, outputPath, maxBodyBytes }));
});