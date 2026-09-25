import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLs, tarFile, untarFirst, isTextName } from './files.js';

const GNU_EPOCH = `total 12
-rw-r--r-- 1 root root 13 1737760000 nginx.conf
-rwxr-xr-x 1 0 0 4096 1737760001 run.sh
drwxr-xr-x 2 root root 4096 1737760002 conf.d
lrwxrwxrwx 1 root root 10 1737760003 link.conf -> nginx.conf
-rw-r--r-- 1 root root 4 1737760004 file with spaces.txt
-rw-r--r-- 1 root root 0 1737760005 quote'name.txt`;

const BUSYBOX = `total 12
-rw-r--r--    1 0        0               11 Sep 25 09:41 blob.bin
drwxr-xr-x    2 0        0               64 Sep 25 09:41 conf.d/
lrwxrwxrwx    1 0        0               10 Sep 25 09:41 link.conf -> nginx.conf
drwxr-xr-x    3 0        0               96 Sep 25 09:41 dir with spaces/
-rwxr-xr-x    1 0        0               18 Sep 25 09:41 run.sh*
-rw-r--r--    1 0        0                5 Jan 10  2025 old.log`;

const GNU_FULL = `total 12
-rw-r--r-- 1 root root 13 2026-01-10 09:30:00.000000000 +0000 nginx.conf
drwxr-xr-x 2 root root 4096 2026-01-10 09:30:01.000000000 +0000 conf.d`;

const names = (out) => parseLs(out).entries.map((e) => e.name);

test('GNU epoch listing', () => {
  const { entries } = parseLs(GNU_EPOCH);
  assert.deepEqual(entries.map((e) => e.name), ['nginx.conf', 'run.sh', 'conf.d', 'link.conf', 'file with spaces.txt', "quote'name.txt"]);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName['nginx.conf'].type, 'file');
  assert.equal(byName['nginx.conf'].mode, 0o644);
  assert.equal(byName['run.sh'].exec, true);
  assert.equal(byName['conf.d'].type, 'dir');
  assert.equal(byName['link.conf'].type, 'link');
  assert.equal(byName['link.conf'].linkTarget, 'nginx.conf');
  assert.equal(byName['conf.d'].mtime, 1737760002000);
});

test('busybox listing', () => {
  const { entries } = parseLs(BUSYBOX);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(entries.map((e) => e.name), ['blob.bin', 'conf.d', 'link.conf', 'dir with spaces', 'run.sh', 'old.log']);
  assert.equal(byName['conf.d'].type, 'dir');
  assert.equal(byName['dir with spaces'].type, 'dir');
  assert.equal(byName['run.sh'].exec, true);
  assert.equal(byName['old.log'].mtime, Date.UTC(2025, 0, 10));
  // months without a year must be recent, not 2001
  assert.ok(byName['blob.bin'].mtime > Date.now() - 366 * 86400_000, 'mtime should be within the last year');
});

test('GNU --full-time listing', () => {
  const { entries } = parseLs(GNU_FULL);
  assert.deepEqual(entries.map((e) => e.name), ['nginx.conf', 'conf.d']);
  assert.equal(entries[0].mtime, Date.UTC(2026, 0, 10, 9, 30, 0));
});

test('garbage and edge lines are ignored', () => {
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('total 4\n./\n../\n'), []);
  assert.deepEqual(names('ls: cannot access: No such file or directory'), []);
});

test('tar round trip', () => {
  const data = Buffer.from('server {\n  listen 80;\n}\n');
  assert.equal(untarFirst(tarFile('nginx.conf', data)).toString(), data.toString());
});

test('binary detection by extension', () => {
  assert.equal(isTextName('app.log'), true);
  assert.equal(isTextName('nginx.conf'), true);
  assert.equal(isTextName('icon.png'), false);
  assert.equal(isTextName('archive.tar.gz'), false);
});
