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

const BIN = '/usr/bin/codeep';
const RUN = '/run/user/1000';
const FILE = `${RUN}/codeep-prompt-AbC123xyz0`;
const LAUNCH = ['omarchy-launch-tui', '--app-id=org.omarchy.codeep'];

test('launchArgv: a bare launch has no prompt file and no --yolo', () => {
  assert.deepEqual(M.launchArgv(BIN, '', false), [...LAUNCH, BIN]);
  assert.deepEqual(M.launchArgv(BIN, null, true), [...LAUNCH, BIN]);
  assert.deepEqual(M.launchArgv(BIN, undefined, true), [...LAUNCH, BIN]);
  // A bare launch is an ordinary session even with the setting on.
  assert.deepEqual(M.launchArgv('/home/u/.local/share/mise/shims/codeep', '', true), [...LAUNCH, '/home/u/.local/share/mise/shims/codeep']);
});

test('launchArgv: with a prompt file, only its path goes on the line, after --prompt-file', () => {
  assert.deepEqual(M.launchArgv(BIN, FILE, false), [...LAUNCH, BIN, '--prompt-file', FILE]);
  assert.deepEqual(M.launchArgv(BIN, FILE, true), [...LAUNCH, BIN, '--yolo', '--prompt-file', FILE]);
  assert.equal(M.launchArgv('codeep', FILE, false), null);     // binary not absolute: not resolved
  assert.equal(M.launchArgv('', FILE, false), null);
});

test('unattended is a strict boolean: only the real `true` adds --yolo', () => {
  assert.ok(!M.launchArgv(BIN, FILE, 'true').includes('--yolo'));
  assert.ok(!M.launchArgv(BIN, FILE, 1).includes('--yolo'));
  assert.ok(M.launchArgv(BIN, FILE, true).includes('--yolo'));
});

test('launchArgv takes a path and never text: anything else is refused, not passed along', () => {
  const hostile = '`id` "quoted" \'single\' --flag -p x\nsecond line; & | < > % \\ end';
  for (const text of [hostile, 'hi', 'fix the bug', 'codeep-prompt-AbC123xyz0', '/fix the bug', '/commit']) {
    assert.equal(M.launchArgv(BIN, text, true), null, JSON.stringify(text));
  }
  // The path has to be one of ours: absolute, one line, the name mktemp makes.
  for (const path of [
    'codeep-prompt-AbC123xyz0', './codeep-prompt-AbC123xyz0', `${RUN}/other-file`, `${RUN}/codeep-prompt-`,
    `${RUN}/codeep-prompt-abc`, `${RUN}/codeep-prompt-abc.txt`, `${RUN}/codeep-prompt-ab c123`,
    `${RUN}/../etc/codeep-prompt-AbC123xyz0`, `${RUN}/codeep-prompt-AbC123xyz0\n--yolo`,
    `${RUN}/codeep-prompt-AbC123\0xyz0`, `${RUN}/codeep-prompt-AbC123xyz0/`, `${RUN}/codeep-prompt-AbC123xyz0 x`,
    // A line break or NUL in a directory part: the name is fine, the path is two lines.
    '/run/user/1000\n/codeep-prompt-AbC123xyz0', '/run/user\r/1000/codeep-prompt-AbC123xyz0', '/run/\0user/1000/codeep-prompt-AbC123xyz0',
    '/', '   ', 42, {}, ['/run/user/1000/codeep-prompt-AbC123xyz0'],
  ]) {
    assert.equal(M.launchArgv(BIN, path, false), null, JSON.stringify(path));
  }
});

test('launchArgv accepts the names Codeep removes (six or more letters and digits)', () => {
  assert.ok(M.launchArgv(BIN, `${RUN}/codeep-prompt-abcdef`, false));
  assert.ok(M.launchArgv(BIN, `/tmp/codeep-prompt-${'a'.repeat(40)}`, false));
});

test('launchArgv doubles every $ in a word because systemd-run reads one in every word', () => {
  // A runtime directory with a $ in it must arrive as it is.
  const argv = M.launchArgv('/opt/$x/codeep', '/run/user/$1000/codeep-prompt-AbC123xyz0', false);
  assert.equal(argv[2], '/opt/$$x/codeep');
  assert.equal(argv.at(-1), '/run/user/$$1000/codeep-prompt-AbC123xyz0');
  assert.deepEqual(M.launchArgv('/opt/$x/codeep', '', false)[2], '/opt/$$x/codeep');
  assert.equal(M.launchArgv(BIN, '/tmp/${HOME}/codeep-prompt-AbC123xyz0', false).at(-1), '/tmp/$${HOME}/codeep-prompt-AbC123xyz0');
});

test('cleanPrompt: no NUL, trimmed, at most 4,000 characters, never half a surrogate pair', () => {
  assert.equal(M.cleanPrompt('  fix it \n'), 'fix it');
  assert.equal(M.cleanPrompt('a\0b\0'), 'ab');
  assert.equal(M.cleanPrompt('line one\nline two'), 'line one\nline two');
  assert.equal(M.cleanPrompt('   '), '');
  assert.equal(M.cleanPrompt(null), '');
  assert.equal(M.cleanPrompt(undefined), '');
  assert.equal(M.cleanPrompt(42), '');
  assert.equal(M.cleanPrompt('x'.repeat(9000)).length, 4000);
  assert.equal(M.cleanPrompt('x'.repeat(4000)).length, 4000);
  // 3,999 letters and then an emoji (two UTF-16 units): the cut falls inside it.
  const cut = M.cleanPrompt('x'.repeat(3999) + '\u{1F680}' + 'tail');
  assert.equal(cut, 'x'.repeat(3999));
  assert.doesNotMatch(cut, /[\ud800-\udbff]$/);
  // The pair is kept whole when it fits.
  assert.equal(M.cleanPrompt('x'.repeat(3998) + '\u{1F680}').length, 4000);
});

test('PROMPT_FILE_MIN_CODEEP is 3.12.1, and supportsPromptFile says who has --prompt-file', () => {
  assert.deepEqual(M.PROMPT_FILE_MIN_CODEEP, [3, 12, 1]);
  assert.equal(M.supportsPromptFile([3, 12, 1]), true);
  assert.equal(M.supportsPromptFile([3, 12, 2]), true);
  assert.equal(M.supportsPromptFile([3, 13, 0]), true);
  assert.equal(M.supportsPromptFile([4, 0, 0]), true);
  assert.equal(M.supportsPromptFile([3, 12, 0]), false);
  assert.equal(M.supportsPromptFile([3, 11, 9]), false);
  assert.equal(M.supportsPromptFile([2, 99, 99]), false);
  assert.equal(M.supportsPromptFile(null), false);
  assert.equal(M.supportsPromptFile(undefined), false);
  // `usage` and the prompt file have their own floors.
  assert.deepEqual(M.MIN_CODEEP, [3, 11, 0]);
  assert.equal(M.versionAtLeast([3, 11, 0], M.MIN_CODEEP), true);
  assert.equal(M.supportsPromptFile([3, 11, 0]), false);
});

test('promptGate: a prompt goes only to a real binary that has --prompt-file', () => {
  assert.deepEqual(M.promptGate(true, [3, 12, 1]), { ok: true });
  assert.deepEqual(M.promptGate(true, [3, 12, 2]), { ok: true });
  const old = M.promptGate(true, [3, 12, 0]);
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'Codeep 3.12.0 is too old to take the prompt privately: install 3.12.1 or later (README: Install). Nothing was started.');
  assert.match(M.promptGate(true, [3, 10, 2]).reason, /^Codeep 3\.10\.2 is too old to take the prompt privately/);
  // The launcher that installs Codeep cannot be asked, and a prompt is never handed to it.
  const launcher = M.promptGate(false, null);
  assert.equal(launcher.ok, false);
  assert.match(launcher.reason, /not set up yet: run it once/);
  assert.equal(M.promptGate(false, [3, 12, 1]).ok, false);
  // A version that was not read is not a version that has it.
  const unknown = M.promptGate(true, null);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /^Could not tell which version of Codeep this is/);
  assert.match(unknown.reason, /Nothing was started/);
  assert.equal(M.promptGate(true, 'v3.12.1').ok, false);
  assert.equal(M.promptGate('yes', [3, 12, 1]).ok, false);
});

test('promptFileTemplate: mktemp in the runtime directory, or nothing', () => {
  assert.deepEqual(M.promptFileTemplate(RUN), ['mktemp', '-p', RUN, 'codeep-prompt-XXXXXXXXXX']);
  assert.deepEqual(M.promptFileTemplate('/run/user/1000/'), ['mktemp', '-p', RUN, 'codeep-prompt-XXXXXXXXXX']);
  assert.deepEqual(M.promptFileTemplate('/run/user/$1000'), ['mktemp', '-p', '/run/user/$1000', 'codeep-prompt-XXXXXXXXXX']);
  for (const dir of ['', 'run/user/1000', './x', '~/x', '/', '//', '/run/user/1000\n', '/run/user\r/1000', '/run/\0user', null, undefined, 42, {}]) {
    assert.equal(M.promptFileTemplate(dir), null, JSON.stringify(dir));
  }
});

test('isPromptFilePath: exactly <dir>/codeep-prompt- and ten letters or digits', () => {
  assert.equal(M.isPromptFilePath(FILE, RUN), true);
  assert.equal(M.isPromptFilePath(FILE, RUN + '/'), true);
  assert.equal(M.isPromptFilePath('/run/user/1000/codeep-prompt-0123456789', RUN), true);
  for (const path of [
    `${RUN}/codeep-prompt-AbC123xyz`,           // nine
    `${RUN}/codeep-prompt-AbC123xyz01`,         // eleven
    `${RUN}/codeep-prompt-AbC123xy_0`,
    `${RUN}/codeep-prompt-AbC123xy.0`,
    `${RUN}/codeep-prompt-AbC123xyz0\n`,        // mktemp's newline is not part of the path
    `${RUN}/codeep-prompt-AbC123xyz0 `,
    `${RUN}/sub/codeep-prompt-AbC123xyz0`,
    `${RUN}//codeep-prompt-AbC123xyz0`,
    `/run/user/1001/codeep-prompt-AbC123xyz0`,  // not this directory
    `/tmp/codeep-prompt-AbC123xyz0`,
    `${RUN}x/codeep-prompt-AbC123xyz0`,
    `${RUN}/Codeep-prompt-AbC123xyz0`,
    `${RUN}/xcodeep-prompt-AbC123xyz0`,
    `${RUN}/codeep-prompt-`,
    '', null, undefined, 7,
  ]) {
    assert.equal(M.isPromptFilePath(path, RUN), false, JSON.stringify(path));
  }
  assert.equal(M.isPromptFilePath(FILE, ''), false);
  assert.equal(M.isPromptFilePath(FILE, 'run/user/1000'), false);
  assert.equal(M.isPromptFilePath(FILE, null), false);
  // What the template makes is what the check accepts, in any directory it can name.
  assert.equal(M.isPromptFilePath('/codeep-prompt-AbC123xyz0', '/'), false);
});

test('promptFileFromOutput: one line, with the one newline mktemp ends it with taken off', () => {
  assert.equal(M.promptFileFromOutput(FILE + '\n', RUN), FILE);
  assert.equal(M.promptFileFromOutput(FILE, RUN), FILE);                // no newline at all is fine
  assert.equal(M.promptFileFromOutput(FILE + '\n\n', RUN), '');         // exactly one
  assert.equal(M.promptFileFromOutput(FILE + '\r\n', RUN), '');
  assert.equal(M.promptFileFromOutput(' ' + FILE + '\n', RUN), '');
  assert.equal(M.promptFileFromOutput(FILE + '\nmore\n', RUN), '');
  assert.equal(M.promptFileFromOutput('mktemp: failed to create file via template\n', RUN), '');
  assert.equal(M.promptFileFromOutput('/tmp/codeep-prompt-AbC123xyz0\n', RUN), '');
  assert.equal(M.promptFileFromOutput('', RUN), '');
  assert.equal(M.promptFileFromOutput(null, RUN), '');
  assert.equal(M.promptFileFromOutput('x'.repeat(5000), RUN), '');
});

test('removeArgv removes only a file of ours, with -f and --', () => {
  assert.deepEqual(M.removeArgv(FILE), ['rm', '-f', '--', FILE]);
  assert.deepEqual(M.removeArgv('/tmp/codeep-prompt-abcdef'), ['rm', '-f', '--', '/tmp/codeep-prompt-abcdef']);
  for (const path of ['/home/u/.bashrc', '/', '/run/user/1000', `${RUN}/*`, `${RUN}/codeep-prompt-*`, 'codeep-prompt-AbC123xyz0',
    `${RUN}/../codeep-prompt-AbC123xyz0`, `${RUN}/codeep-prompt-AbC123xyz0\n/etc/passwd`, '-rf', '', null, undefined]) {
    assert.equal(M.removeArgv(path), null, JSON.stringify(path));
  }
});

test('pending files: several wait at once and each goes at its own time', () => {
  assert.equal(M.PROMPT_FILE_TTL_MS, 120000);
  const a = `${RUN}/codeep-prompt-AaAaAaAaAa`;
  const b = `${RUN}/codeep-prompt-BbBbBbBbBb`;
  let list = M.pendingAdd([], a, 1000);
  list = M.pendingAdd(list, b, 61000);            // a second Ask a minute later
  assert.deepEqual(list, [{ path: a, due: 121000 }, { path: b, due: 181000 }]);
  assert.deepEqual(M.pendingSweep(list, 120999), { due: [], keep: list });
  assert.deepEqual(M.pendingSweep(list, 121000), { due: [a], keep: [{ path: b, due: 181000 }] });
  assert.deepEqual(M.pendingSweep(list, 500000), { due: [a, b], keep: [] });
  // Not ours: not kept for removal either. Bad lists are empty ones.
  assert.deepEqual(M.pendingAdd([], '/home/u/.bashrc', 0), []);
  assert.deepEqual(M.pendingAdd(null, a, 0), [{ path: a, due: 120000 }]);
  assert.deepEqual(M.pendingSweep(null, 0), { due: [], keep: [] });
  // The input list is not changed.
  const before = JSON.stringify(list);
  M.pendingAdd(list, a, 5);
  M.pendingSweep(list, 999999);
  assert.equal(JSON.stringify(list), before);
});

test('what a launch is made of: the prompt text is in no argv the model builds', () => {
  const secret = 'rotate the signing key; then `rm -rf $HOME` "quietly" --yolo \n and tell nobody';
  const prompt = M.cleanPrompt(`  ${secret}  `);
  const plan = M.launchPlan(prompt, true, '/home/u/Work', true, '/home/u');
  assert.equal(plan.ok, true);
  assert.equal(plan.unattended, true);
  const make = M.promptFileTemplate(RUN);
  const path = M.promptFileFromOutput(FILE + '\n', RUN);
  const argvs = [make, M.launchArgv(BIN, path, plan.unattended), M.removeArgv(path), M.launchArgv(BIN, '', false)];
  for (const argv of argvs) assert.ok(Array.isArray(argv));
  const everything = JSON.stringify(argvs);
  for (const piece of ['rotate', 'signing', 'quietly', 'tell nobody', 'rm -rf']) assert.ok(!everything.includes(piece), piece);
  // ...and the only place the text can be put on a line is refused.
  assert.equal(M.launchArgv(BIN, prompt, true), null);
  assert.equal(M.removeArgv(prompt), null);
  assert.equal(M.promptFileTemplate(prompt), null);
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

test('a runtime directory with "." or ".." segments yields no template: a file made there could not be passed or removed', () => {
  for (const dir of ['/run/user/1000/../1000', '/run/./user/1000', '/..', '/run/user/1000/.']) {
    assert.equal(M.promptFileTemplate(dir), null, dir);
  }
  // Whatever template there is, its file can be named for launch and for removal.
  const template = M.promptFileTemplate('/run/user/1000');
  assert.ok(template);
  const path = M.promptFileFromOutput('/run/user/1000/codeep-prompt-AbC123xyz9\n', '/run/user/1000');
  assert.ok(path);
  assert.ok(M.removeArgv(path));
  assert.ok(M.launchArgv('/usr/bin/codeep', path, false));
});

test('the install command the plugin names is pinned to the reviewed Codeep', () => {
  assert.equal(M.REVIEWED_CODEEP, '3.12.1');
  assert.equal(M.INSTALL_COMMAND, 'omarchy-mise-install github:VladoIvankovic/Codeep@3.12.1 codeep');
  // The reviewed version is one the plugin itself accepts for the Ask field.
  assert.equal(M.supportsPromptFile(M.parseVersion('Codeep v' + M.REVIEWED_CODEEP)), true);
  // No notice sends you to `mup`, which would not move a pinned install.
  for (const reason of [M.promptGate(true, [3, 12, 0]).reason, M.promptGate(true, null).reason]) {
    assert.doesNotMatch(reason, /\bmup\b/);
    assert.match(reason, /3\.12\.1/);
  }
});
