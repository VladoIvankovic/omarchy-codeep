import QtQuick
import Quickshell

// An on-device check of the two parts that talk to the system, without the
// shell's bar: run test/harness/run.sh on an Omarchy machine (or any Linux
// with Quickshell). It copies this file and the parts it needs into a
// temporary folder, because Quickshell loads nothing outside its config
// folder, starts the status scanner and the Codeep probe, prints what they
// find as HARNESS lines for eight seconds, and exits. Start or stop a Codeep
// meanwhile to watch the state change, or point it at a fake with
// CODEEP_HARNESS_BINARY.
ShellRoot {
  id: root

  function say(text) { console.log("HARNESS " + text) }

  CodeepCli {
    id: cli
    override: String(Quickshell.env("CODEEP_HARNESS_BINARY") || "")
    onBinaryChanged: root.say("binary: " + binary)
    onLauncherChanged: root.say("launcher (never probed): " + launcher)
    onVersionChanged: root.say("version: " + version)
    onErrorChanged: root.say("error: " + (error === "" ? "(none)" : error))
    onUsageChanged: root.say("usage: " + (usage
      ? "today " + usage.today.tokens + " tokens / " + usage.today.prompts + " prompts, week "
        + usage.week.tokens + " / " + usage.week.prompts + ", " + usage.models.length + " models (" + usage.modelsScope + ")"
      : "null"))
  }

  SessionScanner {
    id: scanner
    intervalMs: 1000
    onSessionsChanged: root.say("sessions: " + JSON.stringify(sessions.map(function(s) {
      return { pid: s.pid, state: s.state, project: s.project, task: s.task, kind: s.kind }
    })))
    onVerdictsChanged: root.say("verdicts: " + JSON.stringify(verdicts))
    onUidChanged: root.say("uid: " + uid + " (status files of other users are ignored)")
    onBootSecChanged: root.say("boot: " + bootSec)
    onOverallChanged: root.say("state: " + overall)
  }

  Component.onCompleted: {
    root.say("status dir: " + scanner.dir)
    root.say("uid known: " + scanner.uidKnown + ", uid " + scanner.uid)
    cli.refresh()
  }

  Timer {
    interval: 8000
    running: true
    onTriggered: {
      root.say("done")
      Qt.quit()
    }
  }
}
