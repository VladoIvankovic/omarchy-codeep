.pragma library

// Everything the widget decides, as plain functions with no Qt in them, so the
// same file runs under QML and under `node --test` (test/model.test.mjs).
//
// What this reads is not trusted. A status file is written by another process
// and may be stale, truncated, hostile or enormous; the output of `codeep` is
// only as good as the binary found on PATH. Every function here takes a string
// or an untyped value and returns either a validated, size-capped result or
// nothing — none of them throws.

// ---------------------------------------------------------------- limits

// A real status file is about 300 bytes: a few paths and a 48-character task.
var MAX_STATUS_BYTES = 16384
// Sessions looked at in one scan: more than anyone runs, fewer than a runaway.
var MAX_SESSIONS = 32
// `codeep usage --json` with a long model list is a few KB.
var MAX_USAGE_BYTES = 262144
// Longest pid Linux hands out (pid_max can be raised to 2^22).
var MAX_PID = 4194304

// `codeep usage --json` and the live status files.
var MIN_CODEEP = [3, 11, 0]

// The Codeep this plugin was reviewed and tested with, and what the plugin says
// wherever it tells you to install or update Codeep: the README's "Which
// Codeep", whose command installs the very file it has checked against the
// reviewed digest. Not a command of its own: an install that only names the
// version pins the version but not the file, and a release on GitHub can be
// replaced. The plugin itself never downloads, installs or updates Codeep, and
// never starts anything that would.
var REVIEWED_CODEEP = "3.12.1"
var INSTALL_HINT = "see \"Which Codeep\" at github.com/VladoIvankovic/omarchy-codeep: Codeep " + REVIEWED_CODEEP + ", checked against its digest"
// `codeep --prompt-file <path>`. Before it Codeep knows neither word: the flag
// is ignored, the path is a stray word, and it starts without the prompt.
var PROMPT_FILE_MIN_CODEEP = [3, 12, 1]
// What the Ask field may hand over, in characters.
var MAX_PROMPT_CHARS = 4000
// How long a prompt file may sit unread before the plugin removes it itself.
// Codeep removes it as it reads it, which is within a second or two.
var PROMPT_FILE_TTL_MS = 120000

// ---------------------------------------------------------------- coercion

// Settings reach the widget from shell.json. `omarchy bar set <id> <key> 60`
// without --json stores the string "60", and "true" for a boolean.
function toBool(value, fallback) {
  if (value === true || value === false) return value
  if (typeof value === "string") {
    var v = value.trim().toLowerCase()
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true
    if (v === "false" || v === "0" || v === "no" || v === "off" || v === "") return false
  }
  if (typeof value === "number") return value !== 0
  return fallback
}

function toInt(value, fallback, min, max) {
  var n = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN)
  if (!isFinite(n)) return fallback
  n = Math.round(n)
  if (n < min) return min
  if (n > max) return max
  return n
}

// "~" and "~/x" become the home directory; anything else must already be
// absolute. A relative path is refused rather than resolved against whatever
// directory the shell happens to be in.
function expandPath(value, home) {
  if (typeof value !== "string") return ""
  var p = value.trim()
  if (p === "" || p.indexOf("\u0000") !== -1) return ""
  if (p === "~") p = home
  else if (p.indexOf("~/") === 0) p = home + p.slice(1)
  if (p.charAt(0) !== "/") return ""
  // A trailing slash is harmless, a ".." segment is how a setting wanders off.
  if (p.split("/").indexOf("..") !== -1) return ""
  return p.length > 1 ? p.replace(/\/+$/, "") : p
}

// ---------------------------------------------------------------- text

// Control characters, C1 controls, soft hyphen, bidirectional and invisible
// formatting characters, line and paragraph separators. Text.PlainText stops
// markup, but it still renders a newline as a line break and honours a
// right-to-left override, so these go as well.
var UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g

function cleanText(value, maxLength) {
  if (typeof value !== "string") return ""
  var text = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim()
  if (maxLength > 0 && text.length > maxLength) text = text.slice(0, Math.max(1, maxLength - 1)).trim() + "\u2026"
  return text
}

function formatCount(value) {
  var n = Number(value)
  if (!isFinite(n) || n < 0) n = 0
  n = Math.round(n)
  var s = String(n)
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function formatTokens(value) {
  var n = Number(value)
  if (!isFinite(n) || n < 0) n = 0
  if (n < 1000) return String(Math.round(n))
  var units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]]
  for (var i = 0; i < units.length; i++) {
    if (n >= units[i][0]) {
      var v = n / units[i][0]
      var text = v < 10 ? v.toFixed(1) : String(Math.round(v))
      if (text.slice(-2) === ".0") text = text.slice(0, -2)
      // 999.6k rounds to 1000k; say 1M.
      if (text === "1000" && i > 0) return "1" + units[i - 1][1]
      return text + units[i][1]
    }
  }
  return String(Math.round(n))
}

// ---------------------------------------------------------------- scan

// One `find` run lists both the status directory and /proc (see
// SessionScanner.qml): one record per entry, records ended by NUL and fields
// separated by tabs, so a file name holding a newline or a tab cannot pass for
// a second record or a second field.
//   S <name> <type> <size> <uid> <mtime>     an entry of the status directory
//   P <pid>                                  a live process
// Only a regular file (type f — a symlink is l, a FIFO p, a directory d),
// named <digits>.json, small, owned by this user, whose pid is alive, is a
// candidate. Anything else is dropped here, before a single byte of it is read.
function parseScan(text, selfUid) {
  var out = { files: [], pids: 0, ignored: 0 }
  if (typeof text !== "string" || text === "") return out
  var records = text.split("\u0000")
  var alive = {}
  var found = []
  for (var i = 0; i < records.length; i++) {
    var record = records[i]
    if (record.length === 0 || record.length > 512) continue
    var parts = record.split("\t")
    if (parts[0] === "P" && parts.length === 2) {
      if (/^[1-9][0-9]{0,9}$/.test(parts[1])) {
        alive[parts[1]] = true
        out.pids++
      }
    } else if (parts[0] === "S" && parts.length === 6) {
      found.push(parts)
    }
  }
  var seen = {}
  for (var j = 0; j < found.length; j++) {
    var f = found[j]
    var name = f[1]
    var match = /^([1-9][0-9]{0,9})\.json$/.exec(name)
    if (!match) { out.ignored++; continue }
    var pid = Number(match[1])
    if (pid < 2 || pid > MAX_PID) { out.ignored++; continue }
    if (f[2] !== "f") { out.ignored++; continue }
    var size = Number(f[3])
    if (!(size > 0 && size <= MAX_STATUS_BYTES)) { out.ignored++; continue }
    var uid = Number(f[4])
    if (selfUid >= 0 && uid !== selfUid) { out.ignored++; continue }
    if (!alive[String(pid)]) continue          // stale: its process is gone
    if (seen[pid]) continue
    seen[pid] = true
    out.files.push({ name: name, pid: pid, size: size, stamp: f[5] + ":" + f[3] })
  }
  out.files.sort(function(a, b) { return a.pid - b.pid })
  if (out.files.length > MAX_SESSIONS) out.files = out.files.slice(0, MAX_SESSIONS)
  return out
}

// ---------------------------------------------------------------- pid identity

// A pid that is alive is not proof that it is the Codeep that wrote the file:
// the file survives a reboot and the number may have been handed to another
// process since. This is the rule Codeep's own cleaner uses
// (src/renderer/omarchyStatus.ts, wasReused): the process began after the file
// says its owner did, and it is plainly not a Codeep. A clock that was stepped
// since the file was written makes a live Codeep look late, so a command line
// that says "codeep" always wins, and a command line that cannot be read does
// not decide anything.

// Linux's USER_HZ, in which /proc/<pid>/stat counts start times. Fixed by the ABI.
var CLOCK_TICKS_PER_SECOND = 100
// How far apart the process's start and the file's `startedAt` may be.
var START_SLACK_MS = 2000

// Field 22 of /proc/<pid>/stat: the start time in ticks since boot, or -1. The
// command name in field 2 may hold spaces and parentheses, so the fields are
// counted from the last ")" on.
function startTicks(statText) {
  if (typeof statText !== "string" || statText.length > 4096) return -1
  var close = statText.lastIndexOf(")")
  if (close === -1) return -1
  var fields = statText.slice(close + 2).trim().split(" ")
  var ticks = fields.length > 19 && /^[0-9]{1,15}$/.test(fields[19]) ? Number(fields[19]) : -1
  return isFinite(ticks) ? ticks : -1
}

// `btime` of /proc/stat: when the machine booted, in seconds since the epoch, or 0.
function bootSeconds(procStat) {
  if (typeof procStat !== "string") return 0
  var m = /^btime ([0-9]{1,12})$/m.exec(procStat)
  return m ? Number(m[1]) : 0
}

// Whether the process now behind a status file's pid is another one's.
// `startedAtMs` is parseStatus's `startedAt` (0 when unknown); `cmdline` is
// /proc/<pid>/cmdline as read, or null when it could not be read.
function isReusedPid(startedAtMs, bootSec, ticks, cmdline) {
  // (No boot time means a start in 1970, which is never later than the file.)
  if (!(startedAtMs > 0) || !(ticks >= 0)) return false
  var processStarted = (bootSec + ticks / CLOCK_TICKS_PER_SECOND) * 1000
  if (!(processStarted > startedAtMs + START_SLACK_MS)) return false
  if (typeof cmdline !== "string") return false
  return !/codeep/i.test(cmdline.replace(/\u0000/g, " "))
}

var STATES = ["idle", "working", "approval", "question"]

// One status file's text. `expectedPid` is the number in the file's name: a
// file that says it belongs to another process is not trusted.
function parseStatus(text, expectedPid) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_STATUS_BYTES) return null
  var doc
  try { doc = JSON.parse(text) } catch (e) { return null }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null
  if (doc.schemaVersion !== 1) return null
  if (doc.pid !== expectedPid) return null
  if (STATES.indexOf(doc.state) === -1) return null
  var kind = doc.kind === "acp" ? "acp" : (doc.kind === "tui" ? "tui" : "")
  if (kind === "") return null
  var task = typeof doc.task === "string" ? cleanText(doc.task, 80) : ""
  var started = typeof doc.startedAt === "string" ? Date.parse(doc.startedAt) : NaN
  var updated = typeof doc.updatedAt === "string" ? Date.parse(doc.updatedAt) : NaN
  return {
    pid: expectedPid,
    kind: kind,
    state: doc.state,
    task: doc.state === "idle" ? "" : task,
    project: cleanText(doc.project, 48),
    provider: cleanText(doc.provider, 32),
    model: cleanText(doc.model, 48),
    startedAt: isFinite(started) ? started : 0,
    updatedAt: isFinite(updated) ? updated : 0
  }
}

var ORDER = { approval: 0, question: 0, working: 1, idle: 2 }

// Needs you first, then working, then idle; the most recently touched first.
function sortSessions(list) {
  return list.slice().sort(function(a, b) {
    var d = ORDER[a.state] - ORDER[b.state]
    if (d !== 0) return d
    d = b.updatedAt - a.updatedAt
    return d !== 0 ? d : a.pid - b.pid
  })
}

// "none" (nothing runs), "idle", "working" or "attention" (an approval or a
// question waits for the user).
function aggregate(list) {
  if (!list || list.length === 0) return "none"
  var working = false
  for (var i = 0; i < list.length; i++) {
    var s = list[i].state
    if (s === "approval" || s === "question") return "attention"
    if (s === "working") working = true
  }
  return working ? "working" : "idle"
}

function stateText(state) {
  if (state === "working") return "Working"
  if (state === "approval") return "Waiting for approval"
  if (state === "question") return "Has a question"
  return "Idle"
}

function describe(list) {
  var state = aggregate(list)
  if (state === "none") return "Codeep is not running"
  var first = list[0]
  var where = first.project !== "" ? " \u00b7 " + first.project : ""
  var many = list.length > 1 ? " (+" + (list.length - 1) + " more)" : ""
  if (state === "attention") return stateText(first.state) + where + many
  if (state === "working") return "Working" + where + many
  return list.length === 1 ? "Idle" + where : list.length + " sessions idle"
}

// ---------------------------------------------------------------- usage

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonNegative(value) {
  var n = Number(value)
  return isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function modelList(models, limit) {
  var rows = []
  if (!plainObject(models)) return { rows: rows, others: 0 }
  var names = Object.keys(models)
  // A hostile or buggy document could list thousands; only what is read is bounded.
  if (names.length > 500) names = names.slice(0, 500)
  for (var i = 0; i < names.length; i++) {
    var m = models[names[i]]
    if (!plainObject(m)) continue
    var tokens = nonNegative(m.inputTokens) + nonNegative(m.outputTokens)
      + nonNegative(m.cacheReadInputTokens) + nonNegative(m.cacheCreationInputTokens)
    rows.push({ name: cleanText(names[i], 40) || "unknown", tokens: tokens })
  }
  rows.sort(function(a, b) { return b.tokens - a.tokens || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)) })
  var others = Math.max(0, rows.length - limit)
  return { rows: rows.slice(0, limit), others: others }
}

// The document `codeep usage --json` prints (schemaVersion 1). Returns
// { ok: true, data } or { ok: false, reason }.
function parseUsage(text) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "empty" }
  if (text.length > MAX_USAGE_BYTES) return { ok: false, reason: "too big" }
  var doc
  try { doc = JSON.parse(text) } catch (e) { return { ok: false, reason: "not JSON" } }
  if (!plainObject(doc)) return { ok: false, reason: "not an object" }
  if (doc.schemaVersion !== 1) return { ok: false, reason: "schemaVersion " + String(doc.schemaVersion).slice(0, 12) }
  if (!plainObject(doc.today) || !plainObject(doc.week) || !plainObject(doc.total)) return { ok: false, reason: "missing fields" }
  var today = modelList(doc.today.byModel, 5)
  var all = modelList(doc.models, 5)
  var days = []
  if (Array.isArray(doc.days)) {
    for (var i = 0; i < doc.days.length && i < 366; i++) {
      var d = doc.days[i]
      if (!plainObject(d)) continue
      days.push({ date: cleanText(d.date, 10), prompts: nonNegative(d.prompts), tokens: nonNegative(d.tokens) })
    }
  }
  return {
    ok: true,
    data: {
      today: { date: cleanText(doc.today.date, 10), prompts: nonNegative(doc.today.prompts), sessions: nonNegative(doc.today.sessions), tokens: nonNegative(doc.today.tokens) },
      week: { prompts: nonNegative(doc.week.prompts), sessions: nonNegative(doc.week.sessions), tokens: nonNegative(doc.week.tokens) },
      total: { prompts: nonNegative(doc.total.prompts), sessions: nonNegative(doc.total.sessions), tokens: nonNegative(doc.total.tokens), firstDate: typeof doc.total.firstDate === "string" ? cleanText(doc.total.firstDate, 10) : "" },
      models: today.rows.length > 0 ? today.rows : all.rows,
      modelsOthers: today.rows.length > 0 ? today.others : all.others,
      modelsScope: today.rows.length > 0 ? "today" : "all time",
      days: days,
      provider: typeof doc.lastProviderName === "string" ? cleanText(doc.lastProviderName, 40) : ""
    }
  }
}

// ---------------------------------------------------------------- codeep binary

// `codeep --version` prints "Codeep v3.11.0".
function parseVersion(text) {
  if (typeof text !== "string" || text.length > 4096) return null
  var m = /(?:^|\s)v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?![\d.])/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function versionAtLeast(v, min) {
  if (!v) return false
  for (var i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true
    if (v[i] < min[i]) return false
  }
  return true
}

function versionText(v) {
  return v ? v[0] + "." + v[1] + "." + v[2] : ""
}

// Whether a parsed version of Codeep can take its prompt from a file.
function supportsPromptFile(v) {
  return versionAtLeast(v, PROMPT_FILE_MIN_CODEEP)
}

// The directories to look for `codeep` in, in the order a shell would: PATH as
// the shell process has it, then the places a version manager or a user
// install leaves it that a service-started process often does not have on
// PATH. Only absolute directories, each once.
function binaryDirs(pathEnv, home) {
  var dirs = []
  function add(d) {
    if (typeof d !== "string" || d.charAt(0) !== "/" || d.indexOf("\n") !== -1) return
    d = d.length > 1 ? d.replace(/\/+$/, "") : d
    if (dirs.indexOf(d) === -1) dirs.push(d)
  }
  var parts = typeof pathEnv === "string" ? pathEnv.split(":") : []
  for (var i = 0; i < parts.length && i < 64; i++) add(parts[i])
  if (home) {
    add(home + "/.local/share/mise/shims")
    add(home + "/.local/bin")
  }
  add("/usr/local/bin")
  add("/usr/bin")
  return dirs
}

// The first line of `find`'s answer that is an absolute path.
function firstPath(text) {
  if (typeof text !== "string") return ""
  var lines = text.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i]
    if (l.charAt(0) === "/" && l.length < 4096 && l.indexOf("\u0000") === -1) return l
  }
  return ""
}

// Every absolute path `find` printed, in order, each once, at most 16.
function allPaths(text) {
  var paths = []
  if (typeof text !== "string") return paths
  var lines = text.split("\n")
  for (var i = 0; i < lines.length && paths.length < 16; i++) {
    var l = lines[i]
    if (l.charAt(0) === "/" && l.length < 4096 && l.indexOf("\u0000") === -1 && paths.indexOf(l) === -1) paths.push(l)
  }
  return paths
}

// ---------------------------------------------------------------- launchers

// Two things named `codeep` are not Codeep: a mise shim (a link to mise, which
// resolves the tool and may install it), and the small script
// `omarchy-mise-install` leaves in ~/.local/bin, which runs `mise use -g` and
// `mise x` and so fetches Codeep from GitHub the first time. A background probe
// that ran either would open a network connection and write mise's global
// configuration every few seconds, and what they download is not checked
// against the digests the README names. So they are never run, by a probe or by
// a click: they are only recognised, so the panel can say what it found.
function isMiseShim(path) {
  return typeof path === "string" && /\/mise\/shims\/[^\/]+$/.test(path)
}

// The first bytes of an executable: a script that mentions mise is a launcher.
// A binary, or a script of another kind (npm's `#!/usr/bin/env node`), is not.
function isLauncherScript(head) {
  if (typeof head !== "string" || head.slice(0, 2) !== "#!") return false
  return /mise/i.test(head.slice(0, 1024))
}

// What every probe of Codeep runs under, whatever it turns out to be: a mise
// that is somehow in the way neither goes online nor installs anything.
var OFFLINE_ENV = ["MISE_OFFLINE=1", "MISE_AUTO_INSTALL=0", "MISE_EXEC_AUTO_INSTALL=0", "MISE_NOT_FOUND_AUTO_INSTALL=0"]

// `env NAME=value … <binary> <args…>`; the binary is an absolute path, so it
// can never be read as another assignment.
function probeArgv(binary, args) {
  return ["env"].concat(OFFLINE_ENV, [binary], args || [])
}

// ---------------------------------------------------------------- launching

var APP_ID = "org.omarchy.codeep"

// `omarchy-launch-tui` hands its words to uwsm-app, and that runs the terminal
// through `systemd-run --scope`, which does with every word what systemd does
// with a unit's command line: "$$" becomes "$", "${NAME}" is replaced by the
// variable's value, and a word that starts with "$NAME" is replaced by the
// variable, split at spaces, or dropped when NAME is not a name. A path such as
// "/run/user/$1000/x" would arrive changed. Doubling every "$" turns each of
// those into the literal character. Nothing else is touched: quotes,
// backslashes, newlines, "%", "--" all pass through verbatim. (The prompt is no
// longer one of these words, see launchArgv; the path still is.)
function forSystemdRun(word) {
  return word.replace(/\$/g, "$$$$")
}

// ---- the prompt, and the file it travels in
//
// The words of a command are public: any local user can read
// /proc/<pid>/cmdline of any process, the terminal's and Codeep's included. So
// the prompt never becomes a word. It is written to a file that only this user
// can open (`mktemp` makes it with mode 0600 in $XDG_RUNTIME_DIR, a 0700
// tmpfs), and only the file's path goes on the command line:
// `codeep --prompt-file <path>` (Codeep 3.12.1). Codeep removes the file when
// it has read it. An environment variable would be private too, but a terminal
// that runs as a single instance starts its child from the server's
// environment, so it would not arrive.

// What Codeep removes after reading: a launcher's own temp file by name.
var PROMPT_FILE_NAME = /^codeep-prompt-[A-Za-z0-9]{6,}$/
// What `mktemp codeep-prompt-XXXXXXXXXX` makes.
var PROMPT_FILE_MADE = /^codeep-prompt-[A-Za-z0-9]{10}$/

// What the Ask field's text becomes before anything is decided about it: no
// NUL, no white space at the ends, at most 4,000 characters, and never half of
// a surrogate pair at the cut.
function cleanPrompt(text) {
  var t = typeof text === "string" ? text.replace(/\u0000/g, "").trim() : ""
  if (t.length > MAX_PROMPT_CHARS) {
    t = t.slice(0, MAX_PROMPT_CHARS)
    var last = t.charCodeAt(t.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1)
  }
  return t
}

// A directory as a prefix: absolute, one line, no trailing "/". "" for
// anything else, and for "/" itself.
function dirPrefix(dir) {
  if (typeof dir !== "string" || dir.charAt(0) !== "/" || /[\u0000\n\r]/.test(dir)) return ""
  // "." and ".." segments are refused here too: a file made in such a
  // directory would be one launchArgv and removeArgv refuse to name.
  var segments = dir.split("/")
  if (segments.indexOf("..") !== -1 || segments.indexOf(".") !== -1) return ""
  return dir.replace(/\/+$/, "")
}

// The `mktemp` that makes the file: `mktemp -p <dir> codeep-prompt-XXXXXXXXXX`
// prints its path. `dir` is $XDG_RUNTIME_DIR; null when that is not a usable
// absolute directory, in which case there is nowhere private to put a prompt.
function promptFileTemplate(runtimeDir) {
  var dir = dirPrefix(runtimeDir)
  if (dir === "") return null
  return ["mktemp", "-p", dir, "codeep-prompt-XXXXXXXXXX"]
}

// Whether `path` is exactly what that `mktemp` makes in `runtimeDir`:
// `<dir>/codeep-prompt-` and ten letters or digits, nothing before or after.
function isPromptFilePath(path, runtimeDir) {
  var dir = dirPrefix(runtimeDir)
  if (dir === "" || typeof path !== "string") return false
  if (path.indexOf(dir + "/") !== 0) return false
  return PROMPT_FILE_MADE.test(path.slice(dir.length + 1))
}

// `mktemp`'s output as the path it made, or "": its one line, with the one
// newline it ends in taken off, and validated as isPromptFilePath does.
function promptFileFromOutput(output, runtimeDir) {
  if (typeof output !== "string" || output.length > 4200) return ""
  var line = output.charAt(output.length - 1) === "\n" ? output.slice(0, -1) : output
  return isPromptFilePath(line, runtimeDir) ? line : ""
}

// A path that may go on a command line as a prompt file, or be removed: of the
// shape the plugin itself makes (see PROMPT_FILE_NAME), absolute, one line,
// without a ".." segment.
function isPromptFileArg(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false
  if (path.charAt(0) !== "/" || /[\u0000\n\r]/.test(path)) return false
  var parts = path.split("/")
  if (parts.indexOf("..") !== -1) return false
  return PROMPT_FILE_NAME.test(parts[parts.length - 1])
}

// The words of the command that opens Codeep in a terminal, or null when it
// must not be run. One element per word and no shell anywhere. `binary` must be
// an absolute path (resolved by the caller). `promptFile` is the path of the
// private file the prompt is in, and nothing else: never text. With no path
// (null, undefined or "") it is the bare launch, an ordinary session; with a
// path that is not one of ours it is null, so a prompt cannot end up in an
// argument by being passed here. `--yolo` is for a launch that has a prompt to
// run: a bare launch (the right click) is an ordinary session, whatever the
// setting says.
function launchArgv(binary, promptFile, unattended) {
  if (typeof binary !== "string" || binary.charAt(0) !== "/") return null
  var argv = ["omarchy-launch-tui", "--app-id=" + APP_ID, forSystemdRun(binary)]
  if (promptFile === undefined || promptFile === null || promptFile === "") return argv
  if (!isPromptFileArg(promptFile)) return null
  if (unattended === true) argv.push("--yolo")
  argv.push("--prompt-file")
  argv.push(forSystemdRun(promptFile))
  return argv
}

// `rm -f -- <path>`, for a file of ours; null for anything else, so this can
// never be made to remove another file.
function removeArgv(path) {
  return isPromptFileArg(path) ? ["rm", "-f", "--", path] : null
}

// Whether a prompt may be handed over now, and what to say when not. The
// version is that of the real binary, parsed; `realBinary` is false when the
// binary the launch resolved is not the one the probes know (only a launcher
// was found, or the binary changed between two steps): nothing is started then,
// least of all a launcher. Returns { ok: true } or { ok: false, reason }. Each
// reason fits the three lines the panel gives it.
function promptGate(realBinary, version) {
  if (realBinary !== true) {
    return { ok: false, reason: "No real Codeep was found (a launcher is never started). Install " + REVIEWED_CODEEP + " (README: Which Codeep). Nothing was started." }
  }
  if (!Array.isArray(version)) {
    return { ok: false, reason: "Codeep did not say its version, so the prompt was not handed over. Install " + REVIEWED_CODEEP + " (README: Which Codeep). Nothing was started." }
  }
  if (!supportsPromptFile(version)) {
    return {
      ok: false,
      reason: "Codeep " + versionText(version) + " is too old to take the prompt privately: install " + REVIEWED_CODEEP + " or later (README: Which Codeep). Nothing was started."
    }
  }
  return { ok: true }
}

// ---- files waiting to be removed
//
// Codeep removes the file as it reads it. A file it never read (the terminal
// did not open, Codeep was too old after all, the launch failed) would stay
// until the session ends, so the plugin removes it after PROMPT_FILE_TTL_MS
// itself. Several can wait at once: one Ask after another is two files.

// The list with `path` added, due `PROMPT_FILE_TTL_MS` after `now`. Anything
// that is not one of our paths is not added.
function pendingAdd(list, path, now) {
  var next = Array.isArray(list) ? list.slice() : []
  if (isPromptFileArg(path)) next.push({ path: path, due: now + PROMPT_FILE_TTL_MS })
  return next
}

// Splits the list at `now` into the paths that are due and the entries that
// still wait.
function pendingSweep(list, now) {
  var due = []
  var keep = []
  if (!Array.isArray(list)) return { due: due, keep: keep }
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (e && typeof e.path === "string" && now >= e.due && due.indexOf(e.path) === -1) due.push(e.path)
    else if (e && typeof e.path === "string" && now < e.due) keep.push(e)
  }
  return { due: due, keep: keep }
}

// "/home/u/Work" as "~/Work": a prefix, on a path boundary, not the first place
// the home folder's text happens to occur.
function tildePath(path, home) {
  if (typeof path !== "string" || typeof home !== "string" || home.length < 2 || home.charAt(0) !== "/") return path
  var h = home.replace(/\/+$/, "")
  if (path === h) return "~"
  return path.indexOf(h + "/") === 0 ? "~" + path.slice(h.length) : path
}

// Where Codeep starts and whether it may run unattended. A work folder that is
// not there is not a reason to run `--yolo` with write access to the whole home
// folder instead: an unattended run is refused, an ordinary one starts in the
// home folder, and a bare launch (no prompt) is an ordinary session anyway.
// Returns { ok: true, dir, unattended } or { ok: false, reason }.
function launchPlan(prompt, unattended, workDir, workDirExists, home) {
  var text = cleanPrompt(prompt)
  var wantsYolo = unattended === true && text !== ""
  if (workDirExists === true) return { ok: true, dir: workDir, unattended: wantsYolo }
  if (wantsYolo) {
    return {
      ok: false,
      reason: "The work folder " + tildePath(workDir, home) + " does not exist, so an unattended run was not started. Create it, or set another with workDir."
    }
  }
  return { ok: true, dir: home !== "" ? home : "/", unattended: false }
}
