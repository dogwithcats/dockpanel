import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_MEMORY = 2000;
const file = path.join(config.dataDir, 'audit.log');
let entries = [];

fs.mkdirSync(config.dataDir, { recursive: true });
try {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-MAX_MEMORY);
  entries = lines.filter(Boolean).map((l) => JSON.parse(l));
} catch {
  /* first run */
}

const stream = fs.createWriteStream(file, { flags: 'a' });

/** Append an operation record: { user, ip, action, target, targetName, ok, detail } */
export function audit(entry) {
  const record = { time: new Date().toISOString(), ...entry };
  entries.push(record);
  if (entries.length > MAX_MEMORY) entries = entries.slice(-MAX_MEMORY);
  stream.write(JSON.stringify(record) + '\n');
}

export function listAudit(limit = 500) {
  return entries.slice(-limit).reverse();
}
