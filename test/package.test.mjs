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

// What the Ask field types is never a word of a command: not of the terminal's,
// not of Codeep's, not of mktemp's. These read the QML, which cannot be run
// here; test/model.test.mjs proves the Model side.

// Every place the widget builds a command: `command: [...]`, `Model.*Argv(...)`.
const commandExpressions = src => [
  ...[...src.matchAll(/\bcommand\s*[:=]\s*([^\n]+)/g)].map(m => m[1]),
  ...[...src.matchAll(/Model\.\w*(?:Argv|Template)\(([^)]*)\)/g)].map(m => m[0]),
  ...[...src.matchAll(/execDetached\(([^\n]+)/g)].map(m => m[1]),
];

test('no QML source builds a command from the prompt', () => {
  for (const file of qmlFiles) {
    const src = read(file);
    for (const expression of commandExpressions(src)) {
      assert.doesNotMatch(expression, /pendingPrompt|askField|\.text\b|cleanPrompt|\bprompt\b|\btext\b/, `${file}: ${expression}`);
    }
  }
  // The launch command is built from the binary, the private file's path and the plan's verdict.
  const widget = read('Widget.qml');
  assert.match(widget, /Model\.launchArgv\(root\.launchBinary, promptFile, root\.launchUnattended\)/);
  assert.match(widget, /Quickshell\.execDetached\(\{ command: argv, workingDirectory: root\.launchDir \}\)/);
  // The path it is given comes from mktemp's own answer, checked by the Model.
  assert.match(widget, /Model\.promptFileFromOutput\(output, root\.runtimeDir\)/);
  assert.match(widget, /root\.launchNow\(root\.promptPath\)/);
});

test('the prompt is written to the private file with FileView.setText, in place, and nowhere else', () => {
  const widget = read('Widget.qml');
  const writer = /FileView \{\s*id: promptWriter([\s\S]*?)\n  \}/.exec(widget);
  assert.ok(writer, 'the promptWriter');
  // In place: a temporary file and a rename would replace mktemp's 0600 file with the umask's.
  assert.match(writer[1], /atomicWrites: false/);
  assert.match(writer[1], /preload: false/);
  assert.match(writer[1], /onSaved: root\.promptWritten\(\)/);
  assert.match(writer[1], /onSaveFailed: root\.promptWriteFailed\(\)/);
  assert.equal([...widget.matchAll(/\.setText\(/g)].length, 1);
  assert.match(widget, /promptWriter\.setText\(root\.pendingPrompt\)/);
  // Where the pending prompt may be read or written: these lines and no others.
  const allowed = [
    /^\s*property string pendingPrompt: ""$/,
    /^\s*\/\/ /,                                           // comments
    /^\s*root\.pendingPrompt = (prompt|"")$/,
    /Model\.launchPlan\(root\.pendingPrompt, root\.unattended, target,/,
    /^\s*if \(root\.pendingPrompt === ""\) \{$/,
    /^\s*promptWriter\.setText\(root\.pendingPrompt\)$/,
  ];
  for (const line of widget.split('\n')) {
    if (!line.includes('pendingPrompt')) continue;
    assert.ok(allowed.some(re => re.test(line)), `pendingPrompt used here: ${line.trim()}`);
  }
});

test('a notice is a fixed sentence: it never holds what was typed', () => {
  const widget = read('Widget.qml');
  const notices = [...widget.matchAll(/abortLaunch\(([^\n]*)\)\s*$/gm)].map(m => m[1]);
  assert.ok(notices.length >= 8, `${notices.length} abortLaunch calls`);
  // A string literal, or the fixed reason the Model's plan or gate returned: never an expression.
  for (const arg of notices) assert.match(arg, /^("[^"+]*"|plan\.reason|gate\.reason|notice)$/, arg);
  // And the only other assignment to the notice is the plan's or the gate's fixed reason.
  for (const m of widget.matchAll(/launchNotice = ([^\n]+)/g)) assert.match(m[1], /^(""|notice)$/, m[0]);
  // No log line, no console output, from any part: nothing could carry a prompt there.
  for (const file of [...qmlFiles, 'Model.js']) assert.doesNotMatch(read(file), /\bconsole\.|\bprint\(|Qt\.(?:log|warning)/, file);
});

test('the version gate comes before any file is made, and a launcher never gets a prompt', () => {
  const widget = read('Widget.qml');
  const plan = widget.indexOf('Model.launchPlan(root.pendingPrompt');
  const gate = widget.indexOf('Model.promptGate(cli.binary !== "" && cli.binary === root.launchBinary,');
  const template = widget.indexOf('Model.promptFileTemplate(root.runtimeDir)');
  const make = widget.indexOf('maker.begin(template)');
  assert.ok(plan > 0 && plan < gate && gate < template && template < make, 'plan, gate, template, mktemp');
  // The version the gate reads must be the one asked for THIS Ask: a leftover
  // from an earlier probe counts as unknown (and CodeepCli drops it when a
  // step fails before the fresh one ran).
  assert.match(widget, /cli\.versionFresh \? cli\.versionParts : null/);
  assert.match(read('CodeepCli.qml'), /if \(root\.wantVersion && !root\.versionFresh\) root\.versionParts = null/);
  assert.match(read('CodeepCli.qml'), /root\.wantVersion = needVersion === true\s*\n\s*root\.versionFresh = false/);
  // ...and a refusal ends the Ask there, with the gate's own reason.
  assert.match(widget, /if \(!gate\.ok\) \{\s*root\.abortLaunch\(gate\.reason\)\s*return\s*\}/);
  // A prompt launch asks for the version afresh; a bare one does not need it.
  assert.match(widget, /cli\.resolve\(prompt !== ""\)/);
  assert.match(widget, /if \(prompt === "" && cli\.launchPath !== ""\) root\.binaryResolved\(cli\.launchPath\)/);
  const cli = read('CodeepCli.qml');
  assert.match(cli, /function resolve\(needVersion\)/);
  assert.match(cli, /root\.wantVersion && !root\.versionFresh/);
  assert.match(cli, /root\.start\("version", Model\.probeArgv\(root\.binary, \["--version"\]\), 10\)/);
  // Too old, or not known, is looked at again at the next Ask: Codeep may have been updated.
  assert.match(cli, /!Model\.supportsPromptFile\(root\.versionParts\)/);
});

test('every step of an Ask is under timeout, and its files are cleaned on every way out', () => {
  const widget = read('Widget.qml');
  assert.match(widget, /command: \["timeout", "-k", "1", "5", "test", "-d", target\]/);
  assert.match(widget, /command = \["timeout", "-k", "1", "5"\]\.concat\(template\)/);
  // The removal of a file is an argv from the Model, under timeout as well.
  assert.match(widget, /\["timeout", "-k", "1", "5"\]\.concat\(argv\)/);
  // One step variable, and one way to end an Ask that did not start Codeep, which removes the file.
  const abort = /function abortLaunch\(notice\) \{[\s\S]*?\n  \}/.exec(widget);
  assert.ok(abort, 'abortLaunch');
  assert.match(abort[0], /root\.removeFile\(root\.promptPath\)/);
  assert.match(abort[0], /root\.launchStage = ""/);
  assert.match(widget, /id: launchWatchdog[\s\S]*?onTriggered: root\.abortLaunch\(/);
  assert.match(widget, /Component\.onDestruction:/);
  // Several files can wait for the two-minute removal at once.
  assert.match(widget, /Model\.pendingAdd\(root\.staleFiles, promptFile, Date\.now\(\)\)/);
  assert.match(widget, /Model\.pendingSweep\(root\.staleFiles, Date\.now\(\)\)/);
  // Nothing left of the old single-slot state.
  assert.doesNotMatch(widget, /launchWanted/);
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
  assert.match(widget, /Model\.launchPlan\(root\.pendingPrompt, root\.unattended, target,/);
  assert.match(widget, /root\.launchUnattended = plan\.unattended/);
  assert.match(widget, /Model\.launchArgv\(root\.launchBinary, promptFile, root\.launchUnattended\)/);
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

test('the README says what is true of the files and of the size', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /writes? no file|writes a file, not even/i);
  assert.doesNotMatch(readme, /a few hundred lines/);
  // "about N lines": the QML and Model.js, as `wc -l *.qml Model.js` counts them.
  const stated = /about ([\d,]+) lines/.exec(readme);
  assert.ok(stated, 'the README gives a line count');
  const lines = readdirSync(root).filter(f => f.endsWith('.qml') || f === 'Model.js')
    .reduce((n, f) => n + read(f).split('\n').length - 1, 0);
  assert.ok(Math.abs(lines - Number(stated[1].replace(/,/g, ''))) <= 100, `README says ${stated[1]}, the files have ${lines}`);
  // The version of the package is the version the README's requirements are written for.
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.version, '1.1.4');
  assert.match(readme, /3\.12\.1/);
});

test('the README makes the Codeep settings a required step before the first Ask', () => {
  const readme = read('README.md');
  // A section of its own, ahead of the Settings table, that the Requirements point to.
  const at = readme.indexOf('## Required setup before the first Ask');
  assert.ok(at > 0, 'the section exists');
  assert.ok(at < readme.indexOf('## Settings'), 'it comes before the plugin\'s own Settings');
  const section = readme.slice(at, readme.indexOf('\n## ', at + 1));
  assert.match(readme.slice(0, at), /Required setup before the first Ask/, 'the Requirements point to it');
  // The three steps, with the exact words Codeep 3.12.1 shows.
  assert.match(section, /`\/settings`[\s\S]*\*\*Desktop notifications\*\*[\s\S]*\*\*Off\*\*/);
  assert.match(section, /\*\*Audit record Off\.\*\* Run `\/audit off`/);
  assert.match(section, /chmod 700 ~\/\.config\/codeep-nodejs/);
  // It says the plugin neither writes nor reads Codeep's settings, and what it does not cover.
  assert.match(section, /never writes Codeep's settings/);
  assert.match(section, /does not read them either/);
  assert.match(section, /`@web <url>`/);
  assert.match(section, /intelligence\.json/);
  // The other sections send the reader there instead of repeating a weaker instruction.
  assert.match(readme, /do step 1 of "Required setup before the first Ask"/);
  assert.match(readme, /Two exceptions\s+come from Codeep itself/);
  // The plugin still never touches Codeep's settings file: no reference in the code.
  for (const file of [...qmlFiles, 'Model.js']) {
    assert.doesNotMatch(read(file), /codeep-nodejs|desktopNotifications|auditLog/, file);
  }
});

test('an aborted Ask keeps what was typed even when it has to open the panel to say why', () => {
  const widget = read('Widget.qml');
  // Opening clears the field and the notice; the abort path says "keep it" first.
  assert.match(widget, /property bool keepTextOnOpen: false/);
  assert.match(widget, /if \(!root\.keepTextOnOpen\) askField\.text = ""/);
  assert.match(widget, /root\.keepTextOnOpen = true\s*\n\s*root\.open\(\)/);
});

test('the README installs exactly the file it checked against the reviewed digest', () => {
  const readme = read('README.md');
  const cli = read('CodeepCli.qml');
  // The panel's hint is the model's, and points to that section, not to a command.
  assert.match(cli, /readonly property string installHint: Model\.INSTALL_HINT/);
  assert.match(read('Model.js'), /var REVIEWED_CODEEP = "3\.12\.1"/);
  assert.match(readme, /^## Which Codeep$/m);
  for (const arch of ['x86_64', 'aarch64']) {
    const asset = `codeep-linux-${arch}.tar.gz`;
    // The digest the table says was reviewed for this asset.
    const row = readme.match(new RegExp('^\\| `' + asset.replace(/\./g, '\\.') + '` \\| [0-9,]+ \\| `([0-9a-f]{64})` \\|$', 'm'));
    assert.ok(row, 'table row for ' + asset);
    const digest = row[1];
    // One line, in a subshell of its own: download, check THAT file against THAT
    // digest, and only then (`&&`, never `;` or a second command) unpack it and
    // install the same file; the temporary folder goes either way.
    const line = '(d=$(mktemp -d) && cd "$d" && curl -fLO https://github.com/VladoIvankovic/Codeep/releases/download/v3.12.1/' + asset +
      ' && echo "' + digest + '  ' + asset + '" | sha256sum -c - && tar -xzf ' + asset +
      ' && install -Dm755 codeep-linux-' + arch + ' ~/.local/bin/codeep; rc=$?; [ -n "$d" ] && rm -rf -- "$d"; exit $rc)';
    assert.ok(readme.split('\n').includes(line), 'checked install line for ' + arch);
  }
  // No instruction left that installs Codeep without that check, and no
  // literal command to copy even in a comment.
  for (const file of ['README.md', 'Model.js', 'CodeepCli.qml', 'Widget.qml']) {
    assert.doesNotMatch(read(file), /omarchy-mise-install github:/, file);
    assert.doesNotMatch(read(file), /mise use -g github:VladoIvankovic/, file);
  }
  assert.doesNotMatch(readme, /mise installs the real binary|right-click the mark|run it once|starts the launcher|let the launcher install/i);
  // The plugin never starts a launcher: only the real binary is what a click starts...
  assert.match(cli, /readonly property string launchPath: root\.binary\n/);
  // Every answer to a launch is that path, and the widget never reaches for the launcher.
  const ready = [...cli.matchAll(/root\.binaryReady\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(ready.length >= 2, 'binaryReady calls');
  for (const arg of ready) assert.equal(arg, 'root.launchPath');
  assert.doesNotMatch(read('Widget.qml'), /cli\.launcher/);
  // "Try in a terminal" names the binary the plugin found, never a bare `codeep`,
  // which could be a launcher that downloads Codeep unchecked.
  for (const m of cli.matchAll(/Try in a terminal: ([^)]*)\)/g)) assert.match(m[1], /^" \+ root\.binary \+ " usage --json"$/, m[0]);
  // ...and the notice for "only a launcher was found" points to the checked install.
  assert.match(cli, /function notSetUp\(\) \{\s*root\.binary = ""\s*root\.fail\("Found only a launcher, which this plugin never starts\. Install Codeep: " \+ root\.installHint\)/);
  // Every notice that tells you to install, update or reinstall Codeep, in the
  // code and in the README's table, carries the hint, and no other way.
  const told = [...cli.matchAll(/(Install it|Install Codeep|Update it|Reinstall it): " \+ ([\w.]+)/g)];
  assert.equal(told.length, 4, 'install, launcher, reinstall and update notices');
  for (const m of told) assert.equal(m[2], 'root.installHint', m[0]);
  const rows = readme.split('\n').filter(l => /^\| .*(Install it|Install Codeep|Update it|Reinstall it):/.test(l));
  assert.ok(rows.length >= 4, 'troubleshooting rows that say how to install');
  // The hint as the panel shows it (model.test.mjs pins Model.INSTALL_HINT to the same words).
  const hint = 'see "Which Codeep" at github.com/VladoIvankovic/omarchy-codeep: Codeep 3.12.1, checked against its digest';
  for (const row of rows) assert.ok(row.includes(hint), row.slice(0, 80));
  // Nowhere an unpinned install, and no "mup" as the way to update.
  for (const file of ['README.md', 'CodeepCli.qml', 'Widget.qml', 'Model.js']) {
    assert.doesNotMatch(read(file), /github:VladoIvankovic\/Codeep codeep/, file);
    assert.doesNotMatch(read(file), /Update: `mup`|Update it: mup|update it \(mup\)|Run `mup`/, file);
  }
  // The digests of the reviewed Linux assets (the files hashed, and equal to what GitHub reports).
  const x86 = '3a0e82181f3a59857fe9103d438c09744cd86879ff09f746a3867e4fb7c7e992';
  const arm = '8cd989ef975c8abe4a797c122d3a68c5ce0447d7021ba0cb604045811498a19c';
  // Each twice: in the table, and in the install line that checks the file before it installs it.
  assert.equal(readme.split(x86).length - 1, 2);
  assert.equal(readme.split(arm).length - 1, 2);
  assert.match(readme, /never downloads, installs or updates Codeep/);
});
