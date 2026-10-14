// What the package promises, checked without Quickshell: the manifest is what
// `omarchy plugin validate` wants, the artwork in assets/ is the artwork the
// QML draws, and the QML keeps to the rules the README states (no shell, no
// network, no markup from data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const qmlFiles = readdirSync(root).filter(f => f.endsWith('.qml'));

// ---- manifest

test('manifest follows the contract of omarchy-plugin-validate', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.schemaVersion, 1);
  for (const key of ['id', 'name', 'version', 'kinds', 'entryPoints', 'author', 'description']) {
    assert.ok(m[key] !== undefined && m[key] !== '', `manifest.${key}`);
  }
  assert.match(m.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!m.id.includes('..'));
  assert.ok(!m.id.startsWith('omarchy.'));
  assert.ok(Array.isArray(m.kinds) && m.kinds.length > 0);
  assert.ok(m.kinds.includes('bar-widget'));
  assert.ok(m.entryPoints.barWidget);
  for (const ep of Object.values(m.entryPoints)) {
    assert.ok(!ep.startsWith('/') && !ep.includes('..'), ep);
    assert.ok(existsSync(join(root, ep)), ep);
  }
  assert.ok(['left', 'center', 'right'].includes(m.barWidget.defaultSection));
});

test('every setting in the schema has a default, and defaults match the schema', () => {
  const m = JSON.parse(read('manifest.json'));
  const keys = m.barWidget.schema.map(s => s.key);
  assert.deepEqual([...keys].sort(), Object.keys(m.barWidget.defaults).sort());
  for (const s of m.barWidget.schema) {
    assert.deepEqual(s.defaultValue, m.barWidget.defaults[s.key], s.key);
    assert.ok(['integer', 'boolean', 'string', 'path'].includes(s.type), s.key);
    assert.ok(s.label, s.key);
  }
  // Unattended must never default to on.
  assert.equal(m.barWidget.defaults.unattended, false);
});

test('the QML reads exactly the settings the manifest declares', () => {
  const m = JSON.parse(read('manifest.json'));
  const declared = new Set(m.barWidget.schema.map(s => s.key));
  const used = new Set();
  for (const file of qmlFiles) {
    for (const match of read(file).matchAll(/setting\("([A-Za-z]+)"/g)) used.add(match[1]);
  }
  for (const key of used) assert.ok(declared.has(key), `${key} is read but not declared`);
  for (const key of declared) assert.ok(used.has(key), `${key} is declared but never read`);
});

test('no symlinks anywhere in the package (the shell refuses them)', () => {
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      assert.ok(!st.isSymbolicLink(), p);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
});

// ---- artwork

const subpaths = d => d.split('Z').map(s => s.trim()).filter(Boolean).map(s => s + 'Z').sort();
const svgPaths = file => [...read(file).matchAll(/\sd="([^"]+)"/g)].flatMap(m => subpaths(m[1])).sort();
const qmlPaths = file => [...read(file).matchAll(/PathSvg \{ path: "([^"]+)" \}/g)].flatMap(m => subpaths(m[1])).sort();

test('the bar mark is Codeep.svg: same shapes in the SVG asset and in Logo.qml', () => {
  assert.deepEqual(qmlPaths('Logo.qml'), svgPaths('assets/logo-mono.svg'));
  // The source of truth, when this repository sits next to Codeep's.
  const source = join(root, '..', 'Codeep', 'Codeep.svg');
  if (existsSync(source)) {
    const original = [...readFileSync(source, 'utf8').matchAll(/\sd="([^"]+)"/g)].flatMap(m => subpaths(m[1])).sort();
    assert.deepEqual(svgPaths('assets/logo-mono.svg'), original);
  }
});

test('the mascot is the website mascot: same shapes in the SVGs and in Mascot.qml', () => {
  assert.deepEqual(qmlPaths('Mascot.qml'), svgPaths('assets/mascot.svg'));
  assert.deepEqual(svgPaths('assets/mascot-mono.svg'), svgPaths('assets/mascot.svg'));
});

test('the mono SVGs follow the surrounding text colour', () => {
  assert.match(read('assets/logo-mono.svg'), /currentColor/);
  assert.match(read('assets/mascot-mono.svg'), /currentColor/);
  assert.doesNotMatch(read('assets/logo-mono.svg'), /#[0-9a-fA-F]{3,6}/);
});

// ---- the rules the README states

test('no shell, no login shell, no bar.run, no execArgv', () => {
  for (const file of [...qmlFiles, 'Model.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /\bbar\.run\(/, file);
    assert.doesNotMatch(src, /Util\.exec(Argv|Detached)/, file);
    // No shell by name (a `-c` alone is `head -c 512`), and no `exec "$@"` trampoline.
    assert.doesNotMatch(src, /["'](?:ba|z|da|fi)?sh["']|\bexec\s+"\$@"/, file);
  }
});

test('no network of its own', () => {
  for (const file of [...qmlFiles, 'Model.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /XMLHttpRequest|\bfetch\(|WebSocket|QtNetwork|https?:\/\/(?!www\.w3\.org)/, file);
  }
});

test('nothing it shows is ever markup: every Text is PlainText', () => {
  for (const file of qmlFiles) {
    const src = read(file);
    assert.doesNotMatch(src, /Text\.(AutoText|StyledText|RichText|MarkdownText)/, file);
    const texts = [...src.matchAll(/(?:^|[\s:])Text\s*\{/gm)].length;
    const plain = [...src.matchAll(/textFormat:\s*Text\.PlainText/g)].length;
    assert.ok(plain >= texts, `${file}: ${texts} Text items, ${plain} PlainText`);
  }
});

test('the prompt reaches the launcher through Model.launchArgv only', () => {
  const widget = read('Widget.qml');
  assert.match(widget, /Model\.launchArgv\(/);
  assert.match(widget, /Quickshell\.execDetached\(\{ command: argv/);
  // The only strings that carry user text into a command are argv elements.
  assert.doesNotMatch(widget, /command:\s*\[[^\]]*\+\s*(prompt|text|pendingPrompt)/);
});

test('unattended is read through toBool and defaults to off in the widget too', () => {
  assert.match(read('Widget.qml'), /Model\.toBool\(setting\("unattended", false\), false\)/);
});

test('no probe runs a launcher: every Codeep command goes through Model.probeArgv', () => {
  const cli = read('CodeepCli.qml');
  assert.match(cli, /Model\.probeArgv\(root\.binary, \["--version"\]\)/);
  assert.match(cli, /Model\.probeArgv\(root\.binary, \["usage", "--json"\]\)/);
  // No other start() hands root.binary (or a candidate) to a process as argv[0].
  const starts = [...cli.matchAll(/root\.start\("(\w+)",\s*([^\n]+)/g)].map(m => [m[1], m[2]]);
  for (const [step, argv] of starts) {
    if (step === 'version' || step === 'usage') assert.match(argv, /Model\.probeArgv/, step);
    else assert.doesNotMatch(argv, /\[root\.binary/, step);
  }
  // The mise question is asked offline, and a shim is skipped before it is peeked at.
  assert.match(cli, /\["env"\]\.concat\(Model\.OFFLINE_ENV, \["mise", "which", "codeep"\]\)/);
  assert.match(cli, /Model\.isMiseShim\(path\)/);
  assert.match(cli, /Model\.isLauncherScript\(output\)/);
});

test('the scanner decides a pid is Codeep\'s by Model.isReusedPid, from /proc, at every scan', () => {
  const scanner = read('SessionScanner.qml');
  assert.match(scanner, /Model\.isReusedPid\(/);
  assert.match(scanner, /path: "\/proc\/" \+ entry\.pid \+ "\/stat"/);
  assert.match(scanner, /path: "\/proc\/" \+ entry\.pid \+ "\/cmdline"/);
  assert.match(scanner, /verdicts\[pid\] === "ok"/);
  assert.match(scanner, /onScanSerialChanged/);
});

test('the Ask field stays inside the card: the head and the foot are pinned, the middle scrolls', () => {
  const widget = read('Widget.qml');
  assert.match(widget, /Flickable \{\s*id: scroller/);
  assert.match(widget, /anchors\.bottom: foot\.top/);
  assert.match(widget, /id: foot\s*\n\s*anchors\.bottom: parent\.bottom/);
  assert.match(widget, /head\.implicitHeight \+ body\.implicitHeight \+ foot\.implicitHeight/);
});

test('an unattended launch goes through Model.launchPlan, and the caption uses a prefix replace', () => {
  const widget = read('Widget.qml');
  assert.match(widget, /Model\.launchPlan\(prompt, root\.unattended, target,/);
  assert.match(widget, /Model\.launchArgv\(cli\.launchPath, prompt, plan\.unattended\)/);
  assert.doesNotMatch(widget, /\.replace\(root\.homeDir/);
  // launchArgv is never handed the setting itself: only the plan's verdict.
  assert.doesNotMatch(widget, /Model\.launchArgv\([^)]*root\.unattended\)/);
});

test('the working cue has a static form for when nothing may move', () => {
  assert.match(read('Widget.qml'), /lit: root\.chasing \? root\.chase : \(root\.working \? 0 : -1\)/);
});

test('numbers and commands in the README and comments are the code\'s', () => {
  const widget = read('Widget.qml');
  const interval = Number(/interval: (\d+)\s*\n\s*repeat: true\s*\n\s*running: root\.chasing/.exec(widget)[1]);
  assert.equal(interval, 450);
  // 450 ms is about two steps a second; nothing may say four.
  for (const file of ['README.md', 'Widget.qml']) assert.doesNotMatch(read(file), /four steps a second/, file);
  assert.match(read('README.md'), /about two steps a second/);
  for (const file of ['Logo.qml', 'Mascot.qml']) assert.doesNotMatch(read(file), /assets\.test\.mjs/, file);
  assert.doesNotMatch(read('test/model.test.mjs'), /node --test test\/\s*$/m);
});

test('the panel opens at the top, not where it was scrolled to last time', () => {
  const widget = read('Widget.qml');
  const handler = /onOpenedChanged: \{[\s\S]*?\n  \}/.exec(widget);
  assert.ok(handler, 'onOpenedChanged');
  assert.match(handler[0], /scroller\.contentY = 0/);
});
