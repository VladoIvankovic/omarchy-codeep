import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Talking to the `codeep` binary, as little and as carefully as possible.
//
//   find      where is it: the directories of PATH, as this shell has it, then
//             the places a version manager leaves it (Model.binaryDirs). `find`
//             and not `command -v`, so no shell is involved anywhere. A step
//             never starts from inside the previous one's exit handler.
//   peek      the first bytes of what `find` found. A mise shim, or the script
//             `omarchy-mise-install` writes (it runs `mise use -g` and `mise x`,
//             which fetch Codeep from GitHub on first use), is a launcher: it is
//             never run by a probe. It is only kept as the thing to start when
//             the user asks for Codeep, in a terminal.
//   which     `mise which codeep` under MISE_OFFLINE=1, from the home folder:
//             where mise put the real binary, when only launchers were found.
//   version   `codeep --version`. `usage` is only run on 3.11.0 or later:
//             before that Codeep ignores words it does not know, so
//             `codeep usage --json` would start the chat instead of failing.
//             A launch with a prompt asks it too (resolve(true)), afresh for
//             that Ask: the prompt goes to Codeep in a file (`--prompt-file`,
//             3.12.1), which an older one would ignore and start without the
//             prompt. If a step fails before that fresh answer, no version is
//             left standing and the gate in Widget.qml refuses.
//   usage     `codeep usage --json`, one JSON document, validated by
//             Model.parseUsage.
//
// One process at a time, each under `timeout` (which also takes the process
// group, so Codeep's launcher script and its child both go), output size
// checked, nothing run from a shell string, and every Codeep probe under
// `env MISE_OFFLINE=1 …` (Model.probeArgv). Everything is killed with this
// item. Failures are one plain line for the panel, with what to do.
Item {
  id: root
  visible: false

  // The "Codeep binary" setting; empty means find it.
  property string override: ""

  // The real binary, which the probes run. Never a launcher.
  property string binary: ""
  // A launcher that was found when there is no real binary yet.
  property string launcher: ""
  // What to start when the user asks for Codeep: the real binary, or else the
  // launcher, whose first run installs it where the user can see it.
  readonly property string launchPath: root.binary !== "" ? root.binary : root.launcher

  // (Not `data`: that is Item's own default property.)
  property var usage: null
  property string error: ""
  property string version: ""
  // The same, parsed ([major, minor, patch]), or null when it is not known:
  // never asked, or the answer was not a version. The launch reads it.
  property var versionParts: null
  property bool loading: false

  // "", "find", "peek", "which", "version", "usage"
  property string step: ""
  property bool wantUsage: false
  property bool wantBinary: false
  // A launch with a prompt wants the version too, and asked for it afresh.
  property bool wantVersion: false
  property bool versionFresh: false
  property bool versionOk: false

  // Discovery state, reset by forget().
  property bool searched: false
  property bool whichTried: false
  property var candidates: []
  property string peeking: ""

  // Emitted when a resolve() finished: what to start, or "" when there is none.
  signal binaryReady(string path)

  readonly property string home: String(Quickshell.env("HOME") || "")

  readonly property string installHint: "omarchy-mise-install github:VladoIvankovic/Codeep codeep"

  function refresh() {
    // Nothing usable yet: look again from the start (Codeep may have been set
    // up since), rather than answering from what the last look found.
    if (root.binary === "" && root.step === "") root.forget()
    root.wantUsage = true
    root.loading = true
    root.pump()
  }

  // Where to start Codeep, and with `needVersion` what version it is, asked
  // now (a prompt launch). Answers through binaryReady, and versionParts.
  function resolve(needVersion) {
    root.wantBinary = true
    root.wantVersion = needVersion === true
    root.versionFresh = false
    // Nothing usable yet, or a binary that was too old (or unknown) when it
    // was last asked: look again from the start. Codeep may have been set up or
    // updated since, and a version manager's path moves with the version.
    if (root.step === "" && (root.binary === ""
        || (root.wantVersion && !Model.supportsPromptFile(root.versionParts)))) {
      root.forget()
    }
    root.pump()
  }

  function forget() {
    root.binary = ""
    root.launcher = ""
    root.versionOk = false
    root.versionParts = null
    root.searched = false
    root.whichTried = false
    root.candidates = []
    root.peeking = ""
  }

  onOverrideChanged: {
    root.forget()
    root.error = ""
  }

  function fail(message) {
    root.error = message
    root.usage = null
    root.step = ""
    root.loading = false
    var hadBinaryWanted = root.wantBinary
    // A launch that wanted the version and did not get a fresh one must not be
    // answered with an older one (Widget's gate also checks versionFresh).
    if (root.wantVersion && !root.versionFresh) root.versionParts = null
    root.wantUsage = false
    root.wantBinary = false
    root.wantVersion = false
    // What there is to start, as far as it is known: a failed `usage` is no
    // reason not to launch.
    if (hadBinaryWanted) root.binaryReady(root.launchPath)
  }

  function missing() {
    root.forget()
    root.fail("Codeep is not installed. Install it: " + root.installHint)
  }

  // Only a launcher was found: Codeep is there to be started, not to be asked.
  function notSetUp() {
    root.binary = ""
    root.fail("Codeep is not set up yet: run codeep once in a terminal (a right click on the mark does that), then this shows its usage.")
  }

  function start(step, argv, seconds) {
    root.step = step
    job.started_ = false
    job.exited_ = false
    job.streamed_ = false
    job.code_ = -1
    job.output_ = ""
    job.workingDirectory = root.home !== "" ? root.home : "/"
    job.command = ["timeout", "-k", "2", String(seconds)].concat(argv)
    job.running = true
  }

  function pump() {
    if (root.step !== "") return
    if (!root.wantUsage && !root.wantBinary) return

    if (root.binary === "") {
      root.discover()
      return
    }

    if (root.wantUsage) {
      if (!root.versionOk) {
        root.start("version", Model.probeArgv(root.binary, ["--version"]), 10)
      } else {
        root.wantUsage = false
        root.start("usage", Model.probeArgv(root.binary, ["usage", "--json"]), 20)
      }
      return
    }

    // Launching Codeep, with a prompt: its version, asked now, before the
    // path is given out. The answer is read from versionParts.
    if (root.wantVersion && !root.versionFresh) {
      root.start("version", Model.probeArgv(root.binary, ["--version"]), 10)
      return
    }

    // Only the path was wanted (launching Codeep).
    root.wantBinary = false
    root.wantVersion = false
    root.binaryReady(root.launchPath)
  }

  // Find the real binary: the setting, or PATH, or what mise says.
  function discover() {
    if (!root.searched) {
      if (root.override !== "") {
        var own = Model.expandPath(root.override, root.home)
        if (own === "") {
          root.fail("The Codeep binary in the settings is not an absolute path: " + root.override.slice(0, 80))
          return
        }
        // A path the user gave is not second-guessed by asking mise.
        root.searched = true
        root.whichTried = true
        root.candidates = [own]
      } else {
        var dirs = Model.binaryDirs(String(Quickshell.env("PATH") || ""), root.home)
        root.start("find", ["find", "-H"].concat(dirs, ["-mindepth", "1", "-maxdepth", "1", "-name", "codeep",
          "-executable", "(", "-type", "f", "-o", "-type", "l", ")", "-printf", "%p\\n"]), 5)
        return
      }
    }
    root.nextCandidate()
  }

  function nextCandidate() {
    while (root.candidates.length > 0) {
      var path = root.candidates[0]
      root.candidates = root.candidates.slice(1)
      if (Model.isMiseShim(path)) {
        if (root.launcher === "") root.launcher = path
        continue
      }
      root.peeking = path
      root.start("peek", ["head", "-c", "512", path], 5)
      return
    }
    if (!root.whichTried) {
      root.whichTried = true
      root.start("which", ["env"].concat(Model.OFFLINE_ENV, ["mise", "which", "codeep"]), 10)
      return
    }
    if (root.launcher !== "") root.notSetUp()
    else root.missing()
  }

  function finished(step, code, output) {
    root.step = ""

    if (step === "find") {
      root.searched = true
      root.candidates = Model.allPaths(output)
      Qt.callLater(root.pump)
      return
    }
    if (step === "peek") {
      var path = root.peeking
      root.peeking = ""
      if (code === 0 && Model.isLauncherScript(output)) {
        if (root.launcher === "") root.launcher = path
      } else if (code === 0) {
        root.binary = path
      }
      // (code != 0: unreadable, or a file that blocks; the next candidate.)
      Qt.callLater(root.pump)
      return
    }
    if (step === "which") {
      var real = code === 0 ? Model.firstPath(output) : ""
      root.candidates = real !== "" && !Model.isMiseShim(real) ? [real] : []
      Qt.callLater(root.pump)
      return
    }

    // 126 and 127: `timeout` or `env` could not run it.
    if (code === 127 || code === 126) { root.missing(); return }

    if (step === "version") {
      root.versionFresh = true
      var v = Model.parseVersion(output)
      if (code !== 0 || v === null) {
        root.versionParts = null
        root.version = ""
        root.versionOk = false
        root.fail("Codeep did not say its version (exit " + code + "). Update it: mup")
        return
      }
      root.versionParts = v
      root.version = Model.versionText(v)
      if (!Model.versionAtLeast(v, Model.MIN_CODEEP)) {
        root.versionOk = false
        root.fail("Codeep " + root.version + " is too old: usage needs " + Model.versionText(Model.MIN_CODEEP) + " or later. Update it: mup")
        return
      }
      root.versionOk = true
      Qt.callLater(root.pump)
      return
    }

    // usage
    root.loading = false
    if (code !== 0) {
      root.versionOk = false
      root.fail("Codeep usage failed (exit " + code + "). Try in a terminal: codeep usage --json")
      return
    }
    var parsed = Model.parseUsage(output)
    if (!parsed.ok) {
      root.versionOk = false
      root.fail("Codeep usage printed something unexpected (" + parsed.reason + "). Try in a terminal: codeep usage --json")
      return
    }
    root.error = ""
    root.usage = parsed.data
    Qt.callLater(root.pump)
  }

  Process {
    id: job

    property bool started_: false
    property bool exited_: false
    property bool streamed_: false
    property int code_: -1
    property string output_: ""

    function settle() {
      if (!exited_ || !streamed_) return
      var step = root.step
      var code = code_
      var out = output_
      output_ = ""
      if (step !== "") root.finished(step, code, out)
    }

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // Never keep more than a document of any size.
        job.output_ = text.length > Model.MAX_USAGE_BYTES ? "" : text
        job.streamed_ = true
        job.settle()
      }
    }
    onStarted: started_ = true
    onExited: function(exitCode, exitStatus) {
      code_ = exitStatus === 0 ? exitCode : 128
      exited_ = true
      settle()
    }
    // A command that could not be started at all reports no exit, only that it
    // is not running (and `timeout` is part of coreutils, so this is rare).
    onRunningChanged: {
      if (!running && !started_ && root.step !== "") {
        var step = root.step
        root.step = ""
        root.fail("Codeep could not be started (" + step + ").")
      }
    }
  }
}
