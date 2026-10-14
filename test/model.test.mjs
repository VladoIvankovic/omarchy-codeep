// Model.js is the widget's whole decision logic, written without Qt so it runs
// here. `node --test test/*.test.mjs` from the repository root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'Model.js'), 'utf8').replace(/^\.pragma library\s*$/m, '');
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
// Results are copied out of the vm's realm, or deepEqual sees two Array classes.
const M = {};
for (const name of Object.keys(ctx)) {
  const value = ctx[name];
  M[name] = typeof value === 'function'
    ? (...args) => { const r = value(...args); return r === undefined || r === null ? r : JSON.parse(JSON.stringify(r)); }
    : JSON.parse(JSON.stringify(value));
}

const status = (over = {}) => JSON.stringify({
  schemaVersion: 1, pid: 1234, kind: 'tui', startedAt: '2026-10-13T09:00:00.000Z',
  updatedAt: '2026-10-13T09:04:12.000Z', cwd: '/home/u/Work/x', project: 'x',
  state: 'working', task: 'fix the login bug', provider: 'z.ai', model: 'glm-5.3', ...over,
}) + '\n';

// ---- settings

test('toInt coerces the strings `omarchy bar set` stores and clamps', () => {
  assert.equal(M.toInt('60', 1, 15, 3600), 60);
  assert.equal(M.toInt(60, 1, 15, 3600), 60);
  assert.equal(M.toInt('5', 60, 15, 3600), 15);
  assert.equal(M.toInt('999999', 60, 15, 3600), 3600);
  assert.equal(M.toInt('abc', 60, 15, 3600), 60);
  assert.equal(M.toInt('', 60, 15, 3600), 60);
  assert.equal(M.toInt(null, 60, 15, 3600), 60);
  assert.equal(M.toInt(undefined, 60, 15, 3600), 60);
  assert.equal(M.toInt({}, 60, 15, 3600), 60);
  assert.equal(M.toInt(NaN, 60, 15, 3600), 60);
});

test('toBool reads true/false in the spellings a shell command leaves', () => {
  assert.equal(M.toBool(true, false), true);
  assert.equal(M.toBool('true', false), true);
  assert.equal(M.toBool('false', true), false);
  assert.equal(M.toBool('maybe', true), true);
  assert.equal(M.toBool(undefined, false), false);
  assert.equal(M.toBool(null, true), true);
});

test('expandPath: home, absolute, and nothing relative or wandering', () => {
  assert.equal(M.expandPath('~/Work', '/home/u'), '/home/u/Work');
  assert.equal(M.expandPath('~', '/home/u'), '/home/u');
  assert.equal(M.expandPath('/srv/code/', '/home/u'), '/srv/code');
  assert.equal(M.expandPath('Work', '/home/u'), '');
  assert.equal(M.expandPath('', '/home/u'), '');
  assert.equal(M.expandPath('/a/../etc', '/home/u'), '');
  assert.equal(M.expandPath('~/../x', '/home/u'), '');
  assert.equal(M.expandPath(42, '/home/u'), '');
  assert.equal(M.expandPath('/a\u0000b', '/home/u'), '');
});

// ---- text

test('cleanText strips what Text.PlainText would still draw', () => {
  assert.equal(M.cleanText('a\nb\r\nc\td', 80), 'a b c d');
  assert.equal(M.cleanText('x‮y', 80), 'x y');          // right-to-left override
  assert.equal(M.cleanText('a b c', 80), 'a b c');  // line and paragraph separators
  assert.equal(M.cleanText('\u001b[31mred\u001b[0m', 80), '[31mred [0m');
  assert.equal(M.cleanText('<b>bold</b>', 80), '<b>bold</b>'); // markup stays text, rendered as PlainText
  assert.equal(M.cleanText(' '.repeat(5) + 'a', 80), 'a');
  assert.equal(M.cleanText(12345, 80), '');
  assert.equal(M.cleanText(null, 80), '');
  const long = M.cleanText('x'.repeat(500), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

test('formatTokens', () => {
  assert.equal(M.formatTokens(0), '0');
  assert.equal(M.formatTokens(584), '584');
  assert.equal(M.formatTokens(1234), '1.2k');
  assert.equal(M.formatTokens(12345), '12k');
  assert.equal(M.formatTokens(999600), '1M');
  assert.equal(M.formatTokens(1234567), '1.2M');
  assert.equal(M.formatTokens(15800000), '16M');
  assert.equal(M.formatTokens(4.2e9), '4.2B');
  assert.equal(M.formatTokens(-5), '0');
  assert.equal(M.formatTokens('x'), '0');
});

// ---- scan

const S = (name, type = 'f', size = 300, uid = 1000, mtime = '1791898244.4') => `S\t${name}\t${type}\t${size}\t${uid}\t${mtime}`;
const P = pid => `P\t${pid}`;

const join0 = records => records.join('\0') + '\0';

test('parseScan keeps a regular, small, own, live file and nothing else', () => {
  const scan = join0([
    S('1234.json'),                       // fine
    S('99999.json'),                      // pid not alive: stale
    S('2147483646.json', 'f', 5000000),   // 5 MB: never read
    S('2147483645.json', 'l'),            // symlink
    S('77.json', 'p'),                    // FIFO
    S('88.json', 'd'),                    // directory
    S('4321.json', 'f', 300, 0),          // someone else's
    S('007.json'),                        // leading zeros
    S('name with space.json'),
    S('7a.json'),
    S('.1234.abcdef012345.tmp'),
    S('5678.json'),                       // fine, alive
    P(1), P(1234), P(2147483646), P(2147483645), P(77), P(88), P(4321), P(7), P(5678),
  ]);
  const out = M.parseScan(scan, 1000);
  assert.deepEqual(out.files.map(f => f.name), ['1234.json', '5678.json']);
});

test('parseScan: size and pid limits each reject on their own', () => {
  const scan = join0([
    S('300.json', 'f', 16384), P(300),            // exactly the cap: kept
    S('301.json', 'f', 16385), P(301),            // one byte over
    S('302.json', 'f', 0), P(302),                // empty
    S('4194304.json', 'f', 300), P(4194304),      // the largest pid Linux hands out: kept
    S('4194305.json', 'f', 300), P(4194305),      // beyond pid_max
    S('1.json', 'f', 300), P(1),                  // init is no Codeep
  ]);
  assert.deepEqual(M.parseScan(scan, 1000).files.map(f => f.name), ['300.json', '4194304.json']);
});

test('parseScan: no uid known means no uid filter; garbage input is empty', () => {
  assert.equal(M.parseScan(join0([S('10.json', 'f', 300, 0), P(10)]), -1).files.length, 1);
  assert.deepEqual(M.parseScan('', 1000).files, []);
  assert.deepEqual(M.parseScan(null, 1000).files, []);
  assert.deepEqual(M.parseScan('S\tonly\tthree\0\0\0P\tabc\0', 1000).files, []);
});

test('parseScan caps the number of files', () => {
  const lines = [];
  for (let pid = 100; pid < 400; pid++) { lines.push(S(`${pid}.json`)); lines.push(P(pid)); }
  assert.equal(M.parseScan(join0(lines), 1000).files.length, M.MAX_SESSIONS);
});

test('parseScan: a file name with a newline or a tab cannot add a process or a field', () => {
  // find prints the name as it is; NUL ends a record, so a newline stays inside it.
  const evil = 'S\t5.json\nP\t4242\tf\t3\t1000\t1\0';
  assert.deepEqual(M.parseScan(evil + join0([S('4242.json')]), 1000).files, []);   // 4242 is not alive: no P record
  const tabbed = 'S\t5\tx.json\tf\t300\t1000\t1\0';
  assert.deepEqual(M.parseScan(tabbed + join0([P(5)]), 1000).files, []);
  const nl = 'P\t4242\n\0';
  assert.deepEqual(M.parseScan(nl + join0([S('4242.json')]), 1000).files, []);
});

// ---- status files

test('parseStatus accepts the documented document', () => {
  const r = M.parseStatus(status(), 1234);
  assert.equal(r.pid, 1234);
  assert.equal(r.state, 'working');
  assert.equal(r.task, 'fix the login bug');
  assert.equal(r.project, 'x');
  assert.equal(r.provider, 'z.ai');
  assert.equal(r.model, 'glm-5.3');
  assert.equal(r.kind, 'tui');
  assert.ok(r.updatedAt > r.startedAt);
});

test('parseStatus rejects what is not the contract', () => {
  assert.equal(M.parseStatus(status(), 999), null);                         // pid is not the file name
  assert.equal(M.parseStatus(status({ pid: '1234' }), 1234), null);         // wrong type
  assert.equal(M.parseStatus(status({ schemaVersion: 2 }), 1234), null);
  assert.equal(M.parseStatus(status({ schemaVersion: '1' }), 1234), null);
  assert.equal(M.parseStatus(status({ state: 'sleeping' }), 1234), null);
  assert.equal(M.parseStatus(status({ state: ['working'] }), 1234), null);
  assert.equal(M.parseStatus(status({ kind: 'daemon' }), 1234), null);
  assert.equal(M.parseStatus('not json', 1234), null);
  assert.equal(M.parseStatus('', 1234), null);
  assert.equal(M.parseStatus('[]', 1234), null);
  assert.equal(M.parseStatus('null', 1234), null);
  assert.equal(M.parseStatus('"x"', 1234), null);
  assert.equal(M.parseStatus('{"schemaVersion":1,', 1234), null);           // truncated
  assert.equal(M.parseStatus('a'.repeat(M.MAX_STATUS_BYTES + 1), 1234), null);
  // Valid JSON, one byte over the cap: refused for its size alone.
  const padded = status({ task: '' });
  const over = padded.replace('"task":""', '"task":"' + 'x'.repeat(M.MAX_STATUS_BYTES - padded.length + 1) + '"');
  assert.ok(over.length > M.MAX_STATUS_BYTES);
  assert.equal(M.parseStatus(over, 1234), null);
  const ok = padded.replace('"task":""', '"task":"' + 'x'.repeat(100) + '"');
  assert.ok(M.parseStatus(ok, 1234));
  assert.equal(M.parseStatus(null, 1234), null);
});

test('parseStatus: hostile strings come out as short plain text', () => {
  const r = M.parseStatus(status({
    project: '<b>x</b>\n<img src="file:///etc/passwd">',
    task: 'line1\nline2‮evil ' + 'y'.repeat(500),
    provider: { a: 1 },
    model: 12,
  }), 1234);
  assert.ok(r);
  assert.ok(!/[\n\r‮]/.test(r.project));
  assert.ok(!/[\n\r‮]/.test(r.task));
  assert.ok(r.task.length <= 80);
  assert.ok(r.project.length <= 48);
  assert.equal(r.provider, '');
  assert.equal(r.model, '');
});

test('parseStatus: idle carries no task; bad dates are zero, not a rejection', () => {
  const r = M.parseStatus(status({ state: 'idle', task: 'left over', startedAt: 'x', updatedAt: null }), 1234);
  assert.equal(r.task, '');
  assert.equal(r.startedAt, 0);
  assert.equal(r.updatedAt, 0);
});

test('__proto__ and friends in a status file do no harm', () => {
  const r = M.parseStatus('{"__proto__":{"state":"working"},"schemaVersion":1,"pid":5,"kind":"tui","state":"idle","task":null}', 5);
  assert.equal(r.state, 'idle');
  assert.equal({}.state, undefined);
});

test('aggregate and sort: a question outranks work outranks idle', () => {
  const mk = (state, pid, updatedAt = 0) => ({ state, pid, updatedAt, project: 'p' + pid, task: '' });
  assert.equal(M.aggregate([]), 'none');
  assert.equal(M.aggregate([mk('idle', 1)]), 'idle');
  assert.equal(M.aggregate([mk('idle', 1), mk('working', 2)]), 'working');
  assert.equal(M.aggregate([mk('working', 2), mk('question', 3), mk('idle', 1)]), 'attention');
  assert.equal(M.aggregate([mk('approval', 3)]), 'attention');
  const sorted = M.sortSessions([mk('idle', 1, 5), mk('working', 2, 1), mk('approval', 3, 0), mk('idle', 4, 9)]);
  assert.deepEqual(sorted.map(s => s.pid), [3, 2, 4, 1]);
});

test('describe says what a person wants to know', () => {
  assert.equal(M.describe([]), 'Codeep is not running');
  assert.equal(M.describe([{ state: 'idle', project: 'x' }]), 'Idle · x');
  assert.equal(M.describe([{ state: 'working', project: 'x' }, { state: 'idle', project: 'y' }]), 'Working · x (+1 more)');
  assert.equal(M.describe([{ state: 'approval', project: 'x' }]), 'Waiting for approval · x');
  assert.equal(M.describe([{ state: 'idle', project: 'x' }, { state: 'idle', project: 'y' }]), '2 sessions idle');
});

// ---- usage

const usageDoc = (over = {}) => JSON.stringify({
  schemaVersion: 1, generatedAt: '2026-10-13T09:30:00.000Z',
  today: { date: '2026-10-13', prompts: 3, sessions: 2, tokens: 584, byModel: { 'glm-5.3': { inputTokens: 51, outputTokens: 6, cacheReadInputTokens: 501, cacheCreationInputTokens: 26 } } },
  days: [{ date: '2026-10-12', prompts: 0, tokens: 0 }, { date: '2026-10-13', prompts: 3, tokens: 584 }],
  week: { prompts: 3, sessions: 2, tokens: 584 },
  total: { prompts: 3, sessions: 2, activeDays: 1, tokens: 584, firstDate: '2026-10-13' },
  models: { 'glm-5.3': { inputTokens: 51, outputTokens: 6, cacheReadInputTokens: 501, cacheCreationInputTokens: 26 } },
  lastProvider: 'z.ai', lastProviderName: 'Z.AI (ZhipuAI)', ...over,
});

test('parseUsage reads the documented document', () => {
  const r = M.parseUsage(usageDoc() + '\n');
  assert.equal(r.ok, true);
  assert.equal(r.data.today.tokens, 584);
  assert.equal(r.data.today.prompts, 3);
  assert.equal(r.data.week.tokens, 584);
  assert.deepEqual(r.data.models, [{ name: 'glm-5.3', tokens: 584 }]);
  assert.equal(r.data.modelsScope, 'today');
  assert.equal(r.data.provider, 'Z.AI (ZhipuAI)');
});

test('parseUsage: an empty ledger is valid and shows zeros', () => {
  const empty = usageDoc({
    today: { date: '2026-10-13', prompts: 0, sessions: 0, tokens: 0, byModel: {} },
    models: {}, days: [], week: { prompts: 0, sessions: 0, tokens: 0 },
    total: { prompts: 0, sessions: 0, activeDays: 0, tokens: 0, firstDate: null },
    lastProvider: null, lastProviderName: null,
  });
  const r = M.parseUsage(empty);
  assert.equal(r.ok, true);
  assert.equal(r.data.today.tokens, 0);
  assert.deepEqual(r.data.models, []);
  assert.equal(r.data.provider, '');
});

test('parseUsage: model list falls back to all time and is capped', () => {
  const models = {};
  for (let i = 0; i < 12; i++) models['m' + i] = { inputTokens: i * 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const r = M.parseUsage(usageDoc({ today: { date: 'd', prompts: 0, sessions: 0, tokens: 0, byModel: {} }, models }));
  assert.equal(r.data.modelsScope, 'all time');
  assert.equal(r.data.models.length, 5);
  assert.equal(r.data.models[0].name, 'm11');
  assert.equal(r.data.modelsOthers, 7);
});

test('parseUsage refuses what is not version 1 or not JSON', () => {
  assert.equal(M.parseUsage('').ok, false);
  assert.equal(M.parseUsage('Codeep - AI-powered coding assistant TUI').ok, false);
  assert.equal(M.parseUsage('[]').ok, false);
  assert.equal(M.parseUsage(usageDoc({ schemaVersion: 2 })).ok, false);
  assert.equal(M.parseUsage('{"schemaVersion":1}').ok, false);
  assert.equal(M.parseUsage('x'.repeat(M.MAX_USAGE_BYTES + 1)).ok, false);
  // Valid, only too big.
  const huge = usageDoc({ lastProviderName: 'p'.repeat(M.MAX_USAGE_BYTES) });
  assert.ok(huge.length > M.MAX_USAGE_BYTES);
  assert.deepEqual(M.parseUsage(huge), { ok: false, reason: 'too big' });
});

test('parseUsage: hostile numbers and names become zeros and short text', () => {
  const r = M.parseUsage(usageDoc({
    today: { date: '<b>', prompts: -5, sessions: 'x', tokens: 1e400, byModel: { '<script>\nx': { inputTokens: 'NaN', outputTokens: -1, cacheReadInputTokens: null, cacheCreationInputTokens: 7 } } },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.data.today.prompts, 0);
  assert.equal(r.data.today.sessions, 0);
  assert.equal(r.data.today.tokens, 0);
  assert.equal(r.data.models[0].tokens, 7);
  assert.ok(!r.data.models[0].name.includes('\n'));
});

// ---- binary + launching

test('parseVersion and versionAtLeast gate `usage`', () => {
  assert.deepEqual(M.parseVersion('Codeep v3.11.0\n'), [3, 11, 0]);
  assert.deepEqual(M.parseVersion('Codeep v3.10.2'), [3, 10, 2]);
  assert.equal(M.parseVersion('Codeep - AI-powered coding assistant TUI'), null);
  assert.equal(M.parseVersion(''), null);
  assert.equal(M.versionAtLeast([3, 11, 0], M.MIN_CODEEP), true);
  assert.equal(M.versionAtLeast([3, 12, 1], M.MIN_CODEEP), true);
  assert.equal(M.versionAtLeast([4, 0, 0], M.MIN_CODEEP), true);
  assert.equal(M.versionAtLeast([3, 10, 9], M.MIN_CODEEP), false);
  assert.equal(M.versionAtLeast([2, 99, 99], M.MIN_CODEEP), false);
  assert.equal(M.versionAtLeast(null, M.MIN_CODEEP), false);
});

test('binaryDirs: PATH first, then the usual homes, absolute and once', () => {
  const dirs = M.binaryDirs('/usr/bin:relative/bin::/home/u/.local/share/mise/shims:/usr/bin', '/home/u');
  assert.deepEqual(dirs, ['/usr/bin', '/home/u/.local/share/mise/shims', '/home/u/.local/bin', '/usr/local/bin']);
  assert.deepEqual(M.binaryDirs(null, ''), ['/usr/local/bin', '/usr/bin']);
});

test('firstPath takes the first absolute line', () => {
  assert.equal(M.firstPath('find: warning\n/home/u/.local/share/mise/shims/codeep\n/usr/bin/codeep\n'), '/home/u/.local/share/mise/shims/codeep');
  assert.equal(M.firstPath(''), '');
  assert.equal(M.firstPath('codeep\n'), '');
});

test('launchArgv: the prompt is one word, last, after `--`', () => {
  const hostile = '`id` "quoted" \'single\' --flag -p x\nsecond line; & | < > % \\ end';
  const argv = M.launchArgv('/home/u/.local/share/mise/shims/codeep', hostile, false);
  assert.deepEqual(argv, ['omarchy-launch-tui', '--app-id=org.omarchy.codeep', '/home/u/.local/share/mise/shims/codeep', '--', hostile]);
  assert.deepEqual(M.launchArgv('/usr/bin/codeep', 'hi', true), ['omarchy-launch-tui', '--app-id=org.omarchy.codeep', '/usr/bin/codeep', '--yolo', '--', 'hi']);
  assert.deepEqual(M.launchArgv('/usr/bin/codeep', '', false), ['omarchy-launch-tui', '--app-id=org.omarchy.codeep', '/usr/bin/codeep']);
  // A bare launch is an ordinary session even with the setting on.
  assert.deepEqual(M.launchArgv('/usr/bin/codeep', '', true), ['omarchy-launch-tui', '--app-id=org.omarchy.codeep', '/usr/bin/codeep']);
  assert.deepEqual(M.launchArgv('/usr/bin/codeep', '   ', true), ['omarchy-launch-tui', '--app-id=org.omarchy.codeep', '/usr/bin/codeep']);
  assert.equal(M.launchArgv('codeep', 'hi', false), null);    // not absolute: not resolved
  assert.equal(M.launchArgv('', 'hi', false), null);
  assert.equal(M.launchArgv('/usr/bin/codeep', 'x'.repeat(9000), false).pop().length, 4000);
});

test('unattended is a strict boolean: only the real `true` adds --yolo', () => {
  assert.ok(!M.launchArgv('/usr/bin/codeep', 'hi', 'true').includes('--yolo'));
  assert.ok(!M.launchArgv('/usr/bin/codeep', 'hi', 1).includes('--yolo'));
  assert.ok(M.launchArgv('/usr/bin/codeep', 'hi', true).includes('--yolo'));
});

test('launchArgv doubles every $ because systemd-run reads one in every word', () => {
  const at = prompt => M.launchArgv('/usr/bin/codeep', prompt, false).pop();
  assert.equal(at('$HOME is where'), '$$HOME is where');
  assert.equal(at('${HOME}/x and $(touch /tmp/p)'), '$${HOME}/x and $$(touch /tmp/p)');
  assert.equal(at('cost $$5'), 'cost $$$$5');
  assert.equal(at('$'), '$$');
  assert.equal(at('no dollar'), 'no dollar');
  // The binary path too, though it should never hold one.
  assert.equal(M.launchArgv('/opt/$x/codeep', '', false)[2], '/opt/$$x/codeep');
});

// ---- launchers: nothing that installs is run by a probe

test('isMiseShim: a link into mise/shims is a shim, anything else is not', () => {
  assert.equal(M.isMiseShim('/home/u/.local/share/mise/shims/codeep'), true);
  assert.equal(M.isMiseShim('/root/.local/share/mise/shims/codeep'), true);
  assert.equal(M.isMiseShim('/home/u/.local/bin/codeep'), false);
  assert.equal(M.isMiseShim('/usr/bin/codeep'), false);
  assert.equal(M.isMiseShim('/home/u/mise/shims/sub/codeep'), false);   // not directly in shims/
  assert.equal(M.isMiseShim(null), false);
});

test('isLauncherScript: the script omarchy-mise-install writes is one; a binary and npm\'s bin are not', () => {
  const wrapper = '#!/bin/bash\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "github:VladoIvankovic/Codeep" || exit 1\nexec mise x "github:VladoIvankovic/Codeep" -- "codeep" "$@"\n';
  assert.equal(M.isLauncherScript(wrapper), true);
  assert.equal(M.isLauncherScript('#!/usr/bin/env node\nrequire("../dist/cli.js")\n'), false);
  assert.equal(M.isLauncherScript('\u007fELF\u0002\u0001\u0001 mise'), false);          // a binary that happens to contain the word
  assert.equal(M.isLauncherScript('#!/bin/sh\nexec /opt/codeep/bin/codeep "$@"\n'), false);
  assert.equal(M.isLauncherScript('echo mise\n'), false);                               // not a script
  assert.equal(M.isLauncherScript(''), false);
  assert.equal(M.isLauncherScript(null), false);
  // The word has to be near the top: 512 bytes are read, 1024 looked at.
  assert.equal(M.isLauncherScript('#!/bin/sh\n' + ' '.repeat(2000) + 'mise'), false);
});

test('allPaths: absolute lines in order, once, at most 16', () => {
  assert.deepEqual(M.allPaths('/a/codeep\nwarning\n/b/codeep\n/a/codeep\n'), ['/a/codeep', '/b/codeep']);
  assert.deepEqual(M.allPaths(''), []);
  assert.deepEqual(M.allPaths(null), []);
  const many = Array.from({ length: 40 }, (_, i) => `/d${i}/codeep`).join('\n');
  assert.equal(M.allPaths(many).length, 16);
});

test('probeArgv: Codeep is always run under an offline, non-installing mise', () => {
  const argv = M.probeArgv('/home/u/bin/codeep', ['usage', '--json']);
  assert.deepEqual(argv, ['env', 'MISE_OFFLINE=1', 'MISE_AUTO_INSTALL=0', 'MISE_EXEC_AUTO_INSTALL=0', 'MISE_NOT_FOUND_AUTO_INSTALL=0',
    '/home/u/bin/codeep', 'usage', '--json']);
  assert.deepEqual(M.probeArgv('/x/codeep', []).slice(-1), ['/x/codeep']);
  assert.ok(M.OFFLINE_ENV.every(w => /^[A-Z_]+=\d$/.test(w)));
});

// ---- a pid that is alive is not necessarily the Codeep that wrote the file

const BOOT = 1791800000;                      // seconds since the epoch
const startedMs = BOOT * 1000 + 3600 * 1000;  // the file says: one hour after boot
const ticksAt = msAfterBoot => Math.round(msAfterBoot / 10);

test('startTicks: field 22, counted from the last ")" of a name that holds spaces and parentheses', () => {
  // Built by position: after the "(name)" come fields 3, 4, ... and field 22 is the 20th of them.
  const fields = Array.from({ length: 30 }, (_, i) => String(i + 3));      // fields 3..32
  fields[22 - 3] = '424242';
  assert.equal(M.startTicks('77 (a b) (c) ' + fields.join(' ')), 424242);
  assert.equal(M.startTicks('77 (x)'), -1);
  assert.equal(M.startTicks('garbage'), -1);
  assert.equal(M.startTicks(null), -1);
  assert.equal(M.startTicks('1 (x) ' + 'y '.repeat(30)), -1);              // field 22 is not a number
});

test('bootSeconds reads btime from /proc/stat', () => {
  assert.equal(M.bootSeconds('cpu  1 2 3\nbtime 1791800000\nprocesses 9\n'), 1791800000);
  assert.equal(M.bootSeconds('cpu  1 2 3\n'), 0);
  assert.equal(M.bootSeconds('xbtime 5\n'), 0);
  assert.equal(M.bootSeconds(null), 0);
});

test('isReusedPid: another process that started after the file, and is no Codeep', () => {
  const late = ticksAt(3600 * 1000 + 600 * 1000);   // started ten minutes after the file's startedAt
  assert.equal(M.isReusedPid(startedMs, BOOT, late, '/usr/bin/sleep\u0000100\u0000'), true);
  assert.equal(M.isReusedPid(startedMs, BOOT, late, ''), true);                 // a zombie: nothing to run
});

test('isReusedPid: the Codeep that wrote it is never taken for another', () => {
  const same = ticksAt(3600 * 1000 - 800);          // up a moment before its status writer began
  assert.equal(M.isReusedPid(startedMs, BOOT, same, '/home/u/.local/share/mise/installs/x/latest/codeep\u0000'), false);
  // Within the slack either way.
  assert.equal(M.isReusedPid(startedMs, BOOT, ticksAt(3600 * 1000 + 1900), 'sleep'), false);
  assert.equal(M.isReusedPid(startedMs, BOOT, ticksAt(3600 * 1000 + 2200), 'sleep'), true);
  // A stepped clock makes a live Codeep look late: its command line decides.
  const late = ticksAt(3600 * 1000 + 600 * 1000);
  assert.equal(M.isReusedPid(startedMs, BOOT, late, 'node\u0000/usr/lib/node_modules/codeep/bin/codeep.js\u0000acp'), false);
  assert.equal(M.isReusedPid(startedMs, BOOT, late, '/opt/CODEEP/bin/x'), false);
});

test('isReusedPid: what cannot be told does not hide anything', () => {
  const late = ticksAt(3600 * 1000 + 600 * 1000);
  assert.equal(M.isReusedPid(startedMs, BOOT, late, null), false);      // command line unreadable
  assert.equal(M.isReusedPid(0, BOOT, late, 'sleep'), false);           // file has no startedAt
  assert.equal(M.isReusedPid(startedMs, 0, late, 'sleep'), false);      // no boot time
  assert.equal(M.isReusedPid(startedMs, BOOT, -1, 'sleep'), false);     // no start time
});

test('parseStatus keeps startedAt in ms for the pid check, 0 when it is not a date', () => {
  assert.equal(M.parseStatus(status(), 1234).startedAt, Date.parse('2026-10-13T09:00:00.000Z'));
  assert.equal(M.parseStatus(status({ startedAt: 'yesterday' }), 1234).startedAt, 0);
  assert.equal(M.parseStatus(status({ startedAt: 5 }), 1234).startedAt, 0);
});

// ---- where Codeep starts, and what an unattended run is allowed to do

test('tildePath replaces the home prefix on a boundary, nowhere else', () => {
  assert.equal(M.tildePath('/home/u/Work', '/home/u'), '~/Work');
  assert.equal(M.tildePath('/home/u', '/home/u'), '~');
  assert.equal(M.tildePath('/home/u/Work', '/home/u/'), '~/Work');            // a home with a trailing slash
  assert.equal(M.tildePath('/srv/home/u/x', '/home/u'), '/srv/home/u/x');      // not at the start
  assert.equal(M.tildePath('/home/user/x', '/home/u'), '/home/user/x');        // not a boundary
  assert.equal(M.tildePath('/data/home/u', '/home/u'), '/data/home/u');
  assert.equal(M.tildePath('/x', ''), '/x');
  assert.equal(M.tildePath('/x', '/'), '/x');
});

test('launchPlan: the work folder is used when it is there', () => {
  assert.deepEqual(M.launchPlan('hi', true, '/home/u/Work', true, '/home/u'), { ok: true, dir: '/home/u/Work', unattended: true });
  assert.deepEqual(M.launchPlan('hi', false, '/home/u/Work', true, '/home/u'), { ok: true, dir: '/home/u/Work', unattended: false });
  // A bare launch is an ordinary session, whatever the setting says.
  assert.deepEqual(M.launchPlan('', true, '/home/u/Work', true, '/home/u'), { ok: true, dir: '/home/u/Work', unattended: false });
  assert.deepEqual(M.launchPlan('  ', true, '/home/u/Work', true, '/home/u'), { ok: true, dir: '/home/u/Work', unattended: false });
});

test('launchPlan: a missing work folder never turns into --yolo in the home folder', () => {
  const refused = M.launchPlan('delete the build', true, '/home/u/Work', false, '/home/u');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /~\/Work does not exist/);
  assert.match(refused.reason, /unattended run was not started/);
  // Not unattended: Codeep asks before it acts, so the home folder is a fallback.
  assert.deepEqual(M.launchPlan('hi', false, '/home/u/Work', false, '/home/u'), { ok: true, dir: '/home/u', unattended: false });
  assert.deepEqual(M.launchPlan('', true, '/home/u/Work', false, '/home/u'), { ok: true, dir: '/home/u', unattended: false });
  assert.deepEqual(M.launchPlan('hi', false, '/w', false, ''), { ok: true, dir: '/', unattended: false });
  // Only the real boolean asks for it.
  assert.equal(M.launchPlan('hi', 'true', '/w', true, '/h').unattended, false);
});
