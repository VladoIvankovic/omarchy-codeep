import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Codeep in the bar.
//
// The bar shows Codeep's mark in the bar's own foreground colour: dim when no
// Codeep runs, normal when one is idle, stepping when one works, in the urgent
// colour when one waits for an approval or has a question. With the animation
// off, "working" is one lit chevron among three dimmed ones, so it still reads
// as different from idle. Left click opens the panel, right click starts Codeep
// in a terminal, middle click refreshes.
//
// The panel shows what `codeep usage --json` says for today and this week, the
// running sessions (read from the live status files Codeep keeps), and a field
// that starts Codeep in a terminal with your words as its first message.
//
// What it does not do: open a network connection, read an API key, put text it
// did not write itself through a shell, or put your prompt on a command line.
// The one file it writes is the private one an Ask hands its prompt over in,
// and it removes that again. See README.md.
Panel {
  id: root

  moduleName: "codeep.agent"
  // The base class would register open/close/toggle; this one adds refresh.
  manageIpc: false

  // ------------------------------------------------------------ settings
  // From this widget's entry in shell.json. `omarchy bar set <id> <key> <v>`
  // without --json stores strings, so everything is coerced and clamped.
  readonly property int usageRefreshSec: Model.toInt(setting("refreshIntervalSec", 60), 60, 15, 3600)
  readonly property int statusIntervalSec: Model.toInt(setting("statusIntervalSec", 3), 3, 1, 60)
  readonly property bool unattended: Model.toBool(setting("unattended", false), false)
  readonly property bool hideWhenIdle: Model.toBool(setting("hideWhenIdle", false), false)
  readonly property bool animate: Model.toBool(setting("animate", true), true)
  readonly property string homeDir: String(Quickshell.env("HOME") || "")
  // Where the prompt's private file goes: a directory only this user can open.
  readonly property string runtimeDir: String(Quickshell.env("XDG_RUNTIME_DIR") || "")
  readonly property string workDir: {
    var own = Model.expandPath(String(setting("workDir", "")), homeDir)
    return own !== "" ? own : homeDir + "/Work"
  }

  // ------------------------------------------------------------ state
  readonly property string scanState: scanner.overall
  readonly property bool attention: scanState === "attention"
  readonly property bool working: scanState === "working"
  readonly property string statusLine: Model.describe(scanner.sessions)

  // Honoured where the shell has the switch (`omarchy toggle animations`).
  // 4.0.4 has not got it; there the "Animate" setting is the only control.
  // Either off: the mark holds one chevron lit instead of moving (see the bar).
  readonly property bool shellReducesMotion: Style.reduceMotion === true
  readonly property bool motionAllowed: animate && !shellReducesMotion
  readonly property bool chasing: working && motionAllowed && visible

  property int chase: 0
  property bool mascotRaised: false

  // ------------------------------------------------------------ colours
  // Tokens only: the panel's own text and surface, the theme's accent, the
  // bar's urgent colour. Dim is the text blended toward the surface, which
  // works on a light theme as on a dark one.
  readonly property color ink: Commons.Color.popups.text
  readonly property color dim: Util.alpha(ink, 0.6)
  readonly property color rule: Util.alpha(ink, 0.14)
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  visible: !(hideWhenIdle && scanner.sessions.length === 0 && !opened)

  // ------------------------------------------------------------ parts
  SessionScanner {
    id: scanner
    intervalMs: root.statusIntervalSec * 1000
  }

  CodeepCli {
    id: cli
    override: String(root.setting("codeepPath", ""))
    onBinaryReady: function(path) { root.binaryResolved(path) }
  }

  // ------------------------------------------------------------ open / refresh
  function refresh() {
    cli.refresh()
  }

  // An aborted Ask opens the panel to show why, and what was typed stays.
  property bool keepTextOnOpen: false

  onOpenedChanged: {
    if (opened) {
      refresh()
      if (!root.keepTextOnOpen) askField.text = ""
      root.keepTextOnOpen = false
      root.launchNotice = ""
      // Always from the top: the position of the last time is not this time's.
      scroller.contentY = 0
    }
  }

  Timer {
    interval: root.usageRefreshSec * 1000
    repeat: true
    running: root.opened
    onTriggered: root.refresh()
  }

  // The "working" cue: about two steps a second (450 ms), and only while it shows.
  Timer {
    interval: 450
    repeat: true
    running: root.chasing
    onTriggered: root.chase = (root.chase + 1) % 4
  }

  // The mascot's bob in the panel header, only while the panel is open.
  Timer {
    interval: 700
    repeat: true
    running: root.opened && root.working && root.motionAllowed
    onTriggered: root.mascotRaised = !root.mascotRaised
    onRunningChanged: if (!running) root.mascotRaised = false
  }

  // ------------------------------------------------------------ launching
  //
  // An Ask goes through these steps, one at a time, one process at a time,
  // each under `timeout`, and any of them can end it (abortLaunch):
  //
  //   binary   where Codeep is, and which version (CodeepCli.resolve)
  //   folder   `test -d` on the work folder, then Model.launchPlan
  //   gate     the version must take the prompt from a file (Model.promptGate)
  //   make     `mktemp` makes a private file in $XDG_RUNTIME_DIR (mode 0600)
  //   write    the prompt is written into that file, in place
  //   launch   `omarchy-launch-tui ... --prompt-file <path>`, then the field is cleared
  //
  // The prompt is never a word of any command: not of mktemp's, not of the
  // terminal's, not of Codeep's. It is text here (pendingPrompt) and in that
  // one file, which Codeep removes as it reads it and which this removes after
  // two minutes if nobody did. A bare launch (the right click) has no prompt,
  // makes no file and skips the gate and the file steps.
  property string pendingPrompt: ""
  // "", "binary", "folder", "make", "write": the step in flight.
  property string launchStage: ""
  // Why the last launch did not happen; shown under the Ask field. Fixed
  // sentences only: it never holds what was typed.
  property string launchNotice: ""
  // What the plan decided, kept for the steps after it.
  property string launchBinary: ""
  property string launchDir: ""
  property bool launchUnattended: false
  // The private file of the launch in flight, from mktemp until the launch or
  // the abort.
  property string promptPath: ""
  // Files handed over and not yet known to be read: [{ path, due }]
  // (Model.pendingAdd), removed after Model.PROMPT_FILE_TTL_MS if still there.
  property var staleFiles: []

  // Each step has its own 30 seconds.
  onLaunchStageChanged: {
    if (launchStage !== "") launchWatchdog.restart()
    else launchWatchdog.stop()
  }

  // `omarchy-launch-tui` is what `omarchy agent` itself uses: one argv, no
  // shell. See Model.launchArgv. What is started is the real binary, or, when
  // Codeep was never set up, the launcher that installs it: that one only ever
  // runs because the user asked, in a terminal where the install shows, and
  // never with a prompt (it cannot be asked for its version, and a prompt
  // cannot be handed to it privately).
  function launchCodeep(prompt) {
    if (root.launchStage !== "") return
    root.pendingPrompt = prompt
    root.launchNotice = ""
    root.launchStage = "binary"
    if (prompt === "" && cli.launchPath !== "") root.binaryResolved(cli.launchPath)
    else cli.resolve(prompt !== "")
  }

  function binaryResolved(path) {
    if (root.launchStage !== "binary") return
    if (path === "") {
      // The panel says why (not installed, bad path).
      root.abortLaunch("")
      if (!root.opened) root.open()
      return
    }
    root.launchBinary = path
    root.launchStage = "folder"
    // The work folder may not exist: see Model.launchPlan for what happens then.
    dirCheck.target = root.workDir
    dirCheck.running = true
  }

  Process {
    id: dirCheck
    property string target: ""
    command: ["timeout", "-k", "1", "5", "test", "-d", target]
    onExited: function(code, status) {
      if (root.launchStage !== "folder") return
      var plan = Model.launchPlan(root.pendingPrompt, root.unattended, target, code === 0 && status === 0, root.homeDir)
      if (!plan.ok) {
        // Nothing starts, and what was typed stays where it is.
        root.abortLaunch(plan.reason)
        return
      }
      root.launchDir = plan.dir
      root.launchUnattended = plan.unattended
      if (root.pendingPrompt === "") {
        root.launchNow("")
        return
      }
      // Only a version asked for THIS Ask counts: one left over from an earlier
      // probe (a step failed before the new one ran) is as good as unknown.
      var gate = Model.promptGate(cli.binary !== "" && cli.binary === root.launchBinary,
        cli.versionFresh ? cli.versionParts : null)
      if (!gate.ok) {
        root.abortLaunch(gate.reason)
        return
      }
      var template = Model.promptFileTemplate(root.runtimeDir)
      if (template === null) {
        root.abortLaunch("There is no private place for the prompt ($XDG_RUNTIME_DIR is not set). Nothing was started.")
        return
      }
      root.launchStage = "make"
      maker.begin(template)
    }
  }

  // `mktemp -p $XDG_RUNTIME_DIR codeep-prompt-XXXXXXXXXX`: it creates the file
  // itself, with mode 0600, and prints its path. Joined like CodeepCli's
  // probe: the answer is read once the process has exited and its output is in.
  Process {
    id: maker
    property bool started_: false
    property bool exited_: false
    property bool streamed_: false
    property int code_: -1
    property string output_: ""

    function begin(template) {
      started_ = false
      exited_ = false
      streamed_ = false
      code_ = -1
      output_ = ""
      command = ["timeout", "-k", "1", "5"].concat(template)
      running = true
    }

    function settle() {
      if (!exited_ || !streamed_) return
      var code = code_
      var out = output_
      output_ = ""
      root.promptFileMade(code, out)
    }

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // One path and a newline: anything longer is not mktemp's.
        maker.output_ = text.length > 1024 ? "" : text
        maker.streamed_ = true
        maker.settle()
      }
    }
    onStarted: started_ = true
    onExited: function(exitCode, exitStatus) {
      code_ = exitStatus === 0 ? exitCode : 128
      exited_ = true
      settle()
    }
    onRunningChanged: {
      if (!running && !started_ && root.launchStage === "make") {
        root.abortLaunch("Could not make a private file for the prompt. Nothing was started.")
      }
    }
  }

  function promptFileMade(code, output) {
    if (root.launchStage !== "make") return
    var path = code === 0 ? Model.promptFileFromOutput(output, root.runtimeDir) : ""
    if (path === "") {
      root.abortLaunch("Could not make a private file for the prompt. Nothing was started.")
      return
    }
    root.promptPath = path
    root.launchStage = "write"
    // In place, not through a temporary file and a rename (atomicWrites): the
    // file exists with mode 0600 from mktemp, and a rename would replace it
    // with one that has whatever the umask gives.
    promptWriter.path = path
    promptWriter.setText(root.pendingPrompt)
    // The text is the file's now, and the field still holds it for a retry.
    root.pendingPrompt = ""
  }

  FileView {
    id: promptWriter
    path: ""
    atomicWrites: false
    preload: false
    blockWrites: false
    watchChanges: false
    printErrors: false
    onSaved: root.promptWritten()
    onSaveFailed: root.promptWriteFailed()
  }

  function promptWritten() {
    if (root.launchStage !== "write") return
    root.launchNow(root.promptPath)
  }

  function promptWriteFailed() {
    if (root.launchStage !== "write") return
    root.abortLaunch("Could not write the prompt to its private file. Nothing was started.")
  }

  // The last step: start Codeep in a terminal. `promptFile` is "" for a bare
  // launch; otherwise the private file, which is now waiting to be read.
  function launchNow(promptFile) {
    var argv = Model.launchArgv(root.launchBinary, promptFile, root.launchUnattended)
    if (argv === null) {
      root.abortLaunch("Codeep could not be started: its path is not usable. Nothing was started.")
      return
    }
    Quickshell.execDetached({ command: argv, workingDirectory: root.launchDir })
    if (promptFile !== "") {
      root.staleFiles = Model.pendingAdd(root.staleFiles, promptFile, Date.now())
      root.promptPath = ""
      root.releaseWriter()
    }
    askField.text = ""
    root.pendingPrompt = ""
    root.launchStage = ""
    if (root.opened) root.close()
  }

  // The end of an Ask that did not start Codeep. What it made is removed at
  // once, what was typed stays in the field, and `notice` says why ("" when
  // something else already does).
  function abortLaunch(notice) {
    if (root.promptPath !== "") {
      root.removeFile(root.promptPath)
      root.promptPath = ""
    }
    root.releaseWriter()
    root.pendingPrompt = ""
    root.launchStage = ""
    // Opened first: opening clears the notice (onOpenedChanged), and the
    // typed text is kept through that open.
    if (notice !== "" && !root.opened) {
      root.keepTextOnOpen = true
      root.open()
    }
    root.launchNotice = notice
  }

  // The FileView holds what it wrote until its path is cleared.
  function releaseWriter() {
    Qt.callLater(function() { promptWriter.path = "" })
  }

  function removeFile(path) {
    var argv = Model.removeArgv(path)
    if (argv !== null) Quickshell.execDetached({ command: ["timeout", "-k", "1", "5"].concat(argv) })
  }

  // Codeep removes the file as it reads it, a second or two after the
  // terminal opens. One that was not read in two minutes is removed here.
  Timer {
    interval: 5000
    repeat: true
    running: root.staleFiles.length > 0
    onTriggered: {
      var swept = Model.pendingSweep(root.staleFiles, Date.now())
      for (var i = 0; i < swept.due.length; i++) root.removeFile(swept.due[i])
      root.staleFiles = swept.keep
    }
  }

  // A step that never got its answer must not block the next Ask for good.
  Timer {
    id: launchWatchdog
    interval: 30000
    onTriggered: root.abortLaunch("Codeep did not answer in time. Nothing was started.")
  }

  // A file that was made and not handed over goes with the widget.
  Component.onDestruction: {
    if (root.promptPath !== "") root.removeFile(root.promptPath)
  }

  function ask(text) {
    var prompt = Model.cleanPrompt(text)
    if (prompt === "") return
    root.launchCodeep(prompt)
  }

  // ------------------------------------------------------------ IPC
  IpcHandler {
    target: "codeep.agent"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refresh() }
  }

  // ------------------------------------------------------------ bar
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Dim, not hidden, when nothing runs: the mark stays where it is.
    dimmed: root.scanState === "none"
    active: root.attention
    tooltipText: "Codeep — " + root.statusLine
    iconComponent: Component {
      Logo {
        color: root.attention ? button.activeColor : button.foreground
        // Moving while it can; otherwise one chevron lit and three dimmed,
        // which is not what an idle mark looks like.
        lit: root.chasing ? root.chase : (root.working ? 0 : -1)
      }
    }
    onPressed: function(code) {
      if (code === Qt.RightButton) root.launchCodeep("")
      else if (code === Qt.MiddleButton) root.refresh()
      else root.toggle()
    }
  }

  // ------------------------------------------------------------ panel
  // Three parts: the header and the Ask field stay where they are, and what is
  // between them (usage, models, sessions) scrolls when the card is not tall
  // enough, so the field is always inside the card however much there is.
  readonly property int maxSessionsShown: 12

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: askField
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(
      head.implicitHeight + body.implicitHeight + foot.implicitHeight + Style.space(14) * 2, Style.space(640))

    FocusScope {
      anchors.fill: parent

      function scrollBy(rows) {
        var room = Math.max(0, scroller.contentHeight - scroller.height)
        scroller.contentY = Math.max(0, Math.min(room, scroller.contentY + rows * Style.space(48)))
      }

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          root.close()
          event.accepted = true
        } else if (event.key === Qt.Key_Tab) {
          root.switchPanel(1)
          event.accepted = true
        } else if (event.key === Qt.Key_Backtab) {
          root.switchPanel(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Down) {
          scrollBy(1)
          event.accepted = true
        } else if (event.key === Qt.Key_Up) {
          scrollBy(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_PageDown) {
          scrollBy(Math.max(1, Math.floor(scroller.height / Style.space(48)) - 1))
          event.accepted = true
        } else if (event.key === Qt.Key_PageUp) {
          scrollBy(-Math.max(1, Math.floor(scroller.height / Style.space(48)) - 1))
          event.accepted = true
        }
      }

      // ---- top: the mascot and what Codeep is doing
      Column {
        id: head
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(14)

        Row {
          width: parent.width
          spacing: Style.space(14)

          Mascot {
            id: mascot
            width: Style.space(46)
            color: root.accent
            raised: root.mascotRaised
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - mascot.width - parent.spacing
            spacing: Style.space(3)

            Line {
              width: parent.width
              text: "Codeep"
              font.pixelSize: Style.font.title
              font.bold: true
            }
            Line {
              width: parent.width
              text: root.statusLine
              color: root.attention ? root.urgent : root.dim
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Rule { }
      }

      // ---- middle: usage, models, what runs now; scrolls
      Item {
        id: middle
        anchors.top: head.bottom
        anchors.topMargin: Style.space(14)
        anchors.bottom: foot.top
        anchors.bottomMargin: Style.space(14)
        anchors.left: parent.left
        anchors.right: parent.right

        Flickable {
          id: scroller
          anchors.fill: parent
          contentWidth: width
          contentHeight: body.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height + 1

          Column {
            id: body
            width: scroller.width
            spacing: Style.space(14)

            // ---- usage: today and this week
            Heading { text: "USAGE" }

            Row {
              width: parent.width
              spacing: Style.space(12)
              visible: cli.usage !== null

              Figures {
                width: (parent.width - parent.spacing) / 2
                title: "Today"
                tokens: cli.usage ? cli.usage.today.tokens : 0
                prompts: cli.usage ? cli.usage.today.prompts : 0
              }
              Figures {
                width: (parent.width - parent.spacing) / 2
                title: "This week"
                tokens: cli.usage ? cli.usage.week.tokens : 0
                prompts: cli.usage ? cli.usage.week.prompts : 0
              }
            }

            Line {
              width: parent.width
              visible: cli.usage === null && cli.error === ""
              text: cli.loading ? "Reading usage…" : "No usage yet"
              color: root.dim
            }

            Line {
              width: parent.width
              visible: cli.error !== ""
              text: cli.error
              color: root.urgent
              wrapMode: Text.WordWrap
              maximumLineCount: 4
              font.pixelSize: Style.font.bodySmall
            }

            // ---- per model
            Column {
              width: parent.width
              spacing: Style.space(6)
              visible: cli.usage !== null && cli.usage.models.length > 0

              Heading { text: cli.usage ? "MODELS · " + cli.usage.modelsScope.toUpperCase() : "" }

              Repeater {
                model: cli.usage ? cli.usage.models : []

                delegate: Item {
                  id: modelRow
                  required property var modelData
                  width: parent.width
                  height: tokensText.implicitHeight

                  Line {
                    anchors.left: parent.left
                    anchors.right: tokensText.left
                    anchors.rightMargin: Style.space(10)
                    text: modelRow.modelData.name
                  }
                  Line {
                    id: tokensText
                    anchors.right: parent.right
                    text: Model.formatTokens(modelRow.modelData.tokens)
                    color: root.dim
                  }
                }
              }

              Line {
                width: parent.width
                visible: cli.usage !== null && cli.usage.modelsOthers > 0
                text: cli.usage ? "+" + cli.usage.modelsOthers + " more" : ""
                color: root.dim
                font.pixelSize: Style.font.bodySmall
              }
            }

            Rule { }

            // ---- what runs now (read-only)
            Heading {
              text: scanner.sessions.length > 0 ? "RUNNING · " + scanner.sessions.length : "RUNNING"
            }

            Line {
              width: parent.width
              visible: scanner.sessions.length === 0
              text: "No Codeep running"
              color: root.dim
            }

            Repeater {
              model: scanner.sessions.length > root.maxSessionsShown
                ? scanner.sessions.slice(0, root.maxSessionsShown) : scanner.sessions

              delegate: Column {
                id: sessionRow
                required property var modelData
                width: body.width
                spacing: Style.space(2)

                readonly property bool needsYou: modelData.state === "approval" || modelData.state === "question"
                readonly property color tone: needsYou ? root.urgent : (modelData.state === "working" ? root.accent : root.dim)

                Item {
                  width: parent.width
                  height: stateText.implicitHeight

                  Rectangle {
                    id: dot
                    width: Style.space(7)
                    height: width
                    radius: width / 2
                    color: sessionRow.tone
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                  }
                  Line {
                    anchors.left: dot.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: stateText.left
                    anchors.rightMargin: Style.space(10)
                    text: sessionRow.modelData.project !== "" ? sessionRow.modelData.project : "Codeep"
                  }
                  Line {
                    id: stateText
                    anchors.right: parent.right
                    text: Model.stateText(sessionRow.modelData.state) + (sessionRow.modelData.kind === "acp" ? " \u00b7 editor" : "")
                    color: sessionRow.tone
                    font.pixelSize: Style.font.bodySmall
                  }
                }

                Line {
                  width: parent.width - Style.space(15)
                  x: Style.space(15)
                  visible: text !== ""
                  text: sessionRow.modelData.task
                  color: root.dim
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }

            Line {
              width: parent.width
              visible: scanner.sessions.length > root.maxSessionsShown
              text: "+" + (scanner.sessions.length - root.maxSessionsShown) + " more"
              color: root.dim
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        // A thin position mark, only where there is something to scroll to.
        Rectangle {
          visible: scroller.contentHeight > scroller.height + 1
          anchors.right: parent.right
          width: Style.space(3)
          radius: width / 2
          color: Util.alpha(root.ink, 0.35)
          y: scroller.visibleArea.yPosition * scroller.height
          height: Math.max(Style.space(16), scroller.visibleArea.heightRatio * scroller.height)
        }
      }

      // ---- bottom: ask
      Column {
        id: foot
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(14)

        Rule { }

        TextField {
          id: askField
          width: parent.width
          placeholderText: "Ask Codeep…"
          maximumLength: 2000
          foreground: root.ink
          accent: root.accent
          font.family: root.fontFamily
          onAccepted: root.ask(text)
          Keys.onTabPressed: function(event) { root.switchPanel(1); event.accepted = true }
          Keys.onBacktabPressed: function(event) { root.switchPanel(-1); event.accepted = true }
        }

        Line {
          width: parent.width
          text: root.launchNotice !== ""
            ? root.launchNotice
            : (root.unattended
              ? "Unattended in " + Model.tildePath(root.workDir, root.homeDir) + ": Codeep will not stop to ask."
              : "Opens Codeep in a terminal in " + Model.tildePath(root.workDir, root.homeDir))
          color: (root.launchNotice !== "" || root.unattended) ? root.urgent : root.dim
          wrapMode: Text.WordWrap
          maximumLineCount: 3
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  // ------------------------------------------------------------ small parts
  // Everything that shows text it did not write itself is a PlainText, one
  // line, elided: a project name or a task label from a file is data, not markup.
  component Line: Text {
    textFormat: Text.PlainText
    color: root.ink
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
    maximumLineCount: 1
    wrapMode: Text.NoWrap
  }

  component Heading: Line {
    width: parent ? parent.width : implicitWidth
    color: root.dim
    font.pixelSize: Style.font.caption
    font.bold: true
    font.letterSpacing: 1.2
    topPadding: Math.ceil(Style.font.caption * 0.15)
  }

  component Rule: Rectangle {
    width: parent ? parent.width : 0
    height: 1
    color: root.rule
  }

  component Figures: Column {
    property string title: ""
    property real tokens: 0
    property real prompts: 0
    spacing: Style.space(2)

    Line {
      width: parent.width
      text: parent.title
      color: root.dim
      font.pixelSize: Style.font.bodySmall
    }
    Line {
      width: parent.width
      text: Model.formatTokens(parent.tokens) + " tokens"
      font.pixelSize: Style.font.heading
      font.bold: true
    }
    Line {
      width: parent.width
      text: Model.formatCount(parent.prompts) + (parent.prompts === 1 ? " prompt" : " prompts")
      color: root.dim
      font.pixelSize: Style.font.bodySmall
    }
  }
}
