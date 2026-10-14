import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The Codeep processes that say they are running, read from the files each
// one keeps in $XDG_STATE_HOME/codeep/sessions/<pid>.json (Codeep 3.11.0,
// Omarchy only, "Share live status with Omarchy plugins" in its settings).
//
// Nothing here trusts what it finds. One `find` run (no shell, under
// `timeout`) lists the directory and /proc together; Model.parseScan keeps only
// a regular file, named <digits>.json, no bigger than a few KB, owned by this
// user, whose process is alive. Only those are opened, one asynchronous
// FileView each, and Model.parseStatus validates every field. A symlink, a
// FIFO, a 5 MB file, someone else's file or a stale one is never read.
//
// A live pid is not yet a live Codeep: a file outlives a reboot, and its number
// may belong to another process by now. Every scan therefore looks at the
// process (its start in /proc/<pid>/stat and its command line, against the
// file's `startedAt`) by the rule Codeep's own cleaner uses
// (Model.isReusedPid); a file whose number was reused is not listed.
//
// One scan at a time, on a timer; no inotify, no long-lived helper process. The
// process, the views and the timer all die with this item.
Item {
  id: root
  visible: false

  property bool active: true
  property int intervalMs: 3000

  readonly property string stateHome: {
    var x = Quickshell.env("XDG_STATE_HOME")
    if (typeof x === "string" && x.charAt(0) === "/") return x.replace(/\/+$/, "")
    return String(Quickshell.env("HOME") || "") + "/.local/state"
  }
  readonly property string dir: stateHome + "/codeep/sessions"

  // The sessions that are alive and well-formed, those that need the user
  // first. Reassigned (never edited in place) so bindings see the change.
  readonly property var sessions: {
    var list = []
    for (var i = 0; i < candidates.length; i++) {
      var pid = candidates[i].pid
      var r = records[pid]
      // Not listed until the process has been looked at, and not when the pid
      // is another process's now.
      if (r && verdicts[pid] === "ok") list.push(r)
    }
    return Model.sortSessions(list)
  }
  // "none", "idle", "working" or "attention". (Not `state`: Item has one.)
  readonly property string overall: Model.aggregate(sessions)

  // ---- internals
  property int uid: -1
  property bool uidKnown: false
  property var candidates: []          // [{ name, pid }]: the live, plausible files
  property var stamps: ({})            // pid -> "<mtime>:<size>": reload on change
  property var records: ({})           // pid -> validated record
  property var verdicts: ({})          // pid -> "ok" | "reused" | "gone"
  property real bootSec: 0             // when the machine booted (/proc/stat)
  property int scanSerial: 0           // counts scans: every one looks at the processes again
  property string candidateKey: ""

  function scanNow() {
    if (!root.active || !root.uidKnown || scan.running) return
    scan.running = true
  }

  function applyScan(text) {
    root.scanSerial = root.scanSerial + 1
    bootFile.reload()
    var result = Model.parseScan(text, root.uid)
    var key = result.files.map(function(f) { return f.name }).join(",")
    var stampMap = ({})
    for (var i = 0; i < result.files.length; i++) stampMap[result.files[i].pid] = result.files[i].stamp
    if (key !== root.candidateKey) {
      root.candidateKey = key
      var keep = ({})
      var kept = ({})
      var list = []
      for (var j = 0; j < result.files.length; j++) {
        var pid = result.files[j].pid
        list.push({ name: result.files[j].name, pid: pid })
        if (root.records[pid]) keep[pid] = root.records[pid]
        if (root.verdicts[pid]) kept[pid] = root.verdicts[pid]
      }
      root.records = keep
      root.verdicts = kept
      root.candidates = list
    }
    root.stamps = stampMap
  }

  function report(pid, record) {
    var next = Object.assign({}, root.records)
    if (record) next[pid] = record
    else delete next[pid]
    root.records = next
  }

  function judge(pid, verdict) {
    if (root.verdicts[pid] === verdict) return
    var next = Object.assign({}, root.verdicts)
    next[pid] = verdict
    root.verdicts = next
  }

  // The real uid of this process, from /proc: the status files must be ours.
  FileView {
    id: selfStatus
    path: "/proc/self/status"
    printErrors: false
    onLoaded: {
      var m = /^Uid:\s+(\d+)/m.exec(text())
      root.uid = m ? Number(m[1]) : -1
      root.uidKnown = true
    }
    onLoadFailed: root.uidKnown = true
  }

  // When the machine booted, to turn a process's start (ticks since boot) into
  // a time that can be compared with the file's. Read again with every scan:
  // a clock that was stepped moves it.
  FileView {
    id: bootFile
    path: "/proc/stat"
    printErrors: false
    onLoaded: root.bootSec = Model.bootSeconds(text())
    onLoadFailed: root.bootSec = 0
  }

  Timer {
    interval: Math.max(1000, root.intervalMs)
    repeat: true
    running: root.active && root.uidKnown
    triggeredOnStart: true
    onTriggered: root.scanNow()
  }

  Process {
    id: scan
    // Records end in NUL and fields are tab-separated (Model.parseScan), so a
    // file name cannot pose as a second record.
    command: ["timeout", "-k", "1", "5", "find", "-H", root.dir, "/proc", "-mindepth", "1", "-maxdepth", "1",
      "(", "-regex", ".*/[1-9][0-9]*\\.json", "-printf", "S\\t%f\\t%y\\t%s\\t%U\\t%T@\\0", ")",
      "-o",
      "(", "-regex", "/proc/[1-9][0-9]*", "-printf", "P\\t%f\\0", ")"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyScan(text)
    }
  }

  Repeater {
    model: root.candidates

    delegate: Item {
      id: entry
      required property var modelData
      visible: false
      readonly property int pid: modelData.pid
      readonly property string stamp: root.stamps[modelData.pid] || ""

      // What /proc says about the process behind the number. `loaded` is false
      // until both reads have answered; `ticks` is -1 and `cmdline` null where
      // they could not be read (the process left between the scan and now).
      property bool statLoaded: false
      property bool cmdLoaded: false
      property real ticks: -1
      property var cmdline: null
      readonly property real startedAt: root.records[pid] ? root.records[pid].startedAt : 0
      readonly property string verdict: {
        if (!statLoaded || !cmdLoaded) return "unknown"
        if (ticks < 0) return "gone"
        return Model.isReusedPid(startedAt, root.bootSec, ticks, cmdline) ? "reused" : "ok"
      }
      onVerdictChanged: if (verdict !== "unknown") root.judge(pid, verdict)
      Component.onCompleted: if (verdict !== "unknown") root.judge(pid, verdict)

      // The scan saw the file change (a write replaces the file whole).
      onStampChanged: file.reload()

      // The scan runs again: so does the look at the process.
      Connections {
        target: root
        function onScanSerialChanged() {
          procStat.reload()
          procCmd.reload()
        }
      }

      FileView {
        id: procStat
        path: "/proc/" + entry.pid + "/stat"
        printErrors: false
        onLoaded: { entry.ticks = Model.startTicks(text()); entry.statLoaded = true }
        onLoadFailed: { entry.ticks = -1; entry.statLoaded = true }
      }

      FileView {
        id: procCmd
        path: "/proc/" + entry.pid + "/cmdline"
        printErrors: false
        onLoaded: { entry.cmdline = text(); entry.cmdLoaded = true }
        onLoadFailed: { entry.cmdline = null; entry.cmdLoaded = true }
      }

      FileView {
        id: file
        path: root.dir + "/" + entry.modelData.name
        printErrors: false
        onLoaded: root.report(entry.pid, Model.parseStatus(text(), entry.pid))
        onLoadFailed: root.report(entry.pid, null)
      }
    }
  }
}
