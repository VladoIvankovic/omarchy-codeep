# Codeep for Omarchy

Codeep in the bar of [Omarchy](https://omarchy.org)'s shell: whether it is idle,
working or waiting for you, what it used today and this week, and a field that
starts it in a terminal with your prompt.

![The mark in the bar: nothing running, idle, working, waiting](docs/bar-states.png)

![The panel](docs/panel.png)

## What it shows

**In the bar**, Codeep's mark in the bar's own foreground colour:

| State | The mark |
|---|---|
| No Codeep running | dim |
| One is running and idle | normal |
| One is working | the four chevrons light up one after the other, about two steps a second; with the animation off, one chevron stays lit and the other three are dimmed |
| One waits for an approval or has a question | the bar's urgent colour |

Left click opens the panel, right click starts Codeep in a terminal, middle
click refreshes. The tooltip says what is going on.

**In the panel**:

- the mascot and a line saying what Codeep is doing;
- **Usage**: tokens and prompts today and over the last seven days, and tokens
  per model (today's, or all time while nothing was used today), from
  `codeep usage --json`. Refreshed when the panel opens and every 60 seconds
  while it is open;
- **Running**: every Codeep process that says it is running — project, state,
  and the short label of what it is working on. Read-only;
- **Ask Codeep…**: type a prompt and press Enter. A terminal opens running
  `codeep -- "<your prompt>"`, in `~/Work` (a setting), with the prompt as one
  argument and nothing in between that could read it as a command. The header
  and this field stay put; usage, models and running sessions scroll (wheel,
  Up/Down, PageUp/PageDown) when there is more than fits.

Colours come from the shell's own theme tokens, so it reads on a light theme as
on a dark one. The mark is Codeep's logo (`Codeep.svg`) and the header's mascot
is the website's, drawn in the theme's accent colour; `assets/` has both as
SVG, in one colour that follows the text (`currentColor`) and the mascot in its
own red.

## Requirements

- Omarchy with the shell plugin host (Omarchy 4). Written and tested against
  the 4.0.4 package (Quickshell 0.3.1, Qt 6.11) and read against upstream's
  `quattro` branch of 2026-10-09.
- **Codeep 3.11.0 or later.** Earlier ones have neither `codeep usage --json`
  nor the live status files. Install: `omarchy-mise-install
  github:VladoIvankovic/Codeep codeep`. Update: `mup`.
- Codeep's **Share live status with Omarchy plugins** setting (on by default,
  in `/settings`, shown on Omarchy only). With it off the bar mark stays dim
  and the panel lists nothing running; usage and Ask still work.
- `find`, `timeout`, `head`, `env` and `test` (findutils, coreutils) and
  `omarchy-launch-tui`, which Omarchy has; `mise`, for a mise-installed Codeep.

## Install

```bash
omarchy plugin add <git url>
omarchy plugin enable codeep.agent --section right --after omarchy.agents
```

(`omarchy plugin add <git url> --enable` does both at once and puts the mark in
its default place, on the right.) A plugin is code that runs inside the shell
with your rights, so Omarchy asks first and lets you read it before you enable
it. This one is a few hundred lines; the sections below say what it touches.

Move it with `omarchy bar move codeep.agent --section left --index 1`, remove it
with `omarchy plugin remove codeep.agent`.

From a terminal or a key binding:

```bash
omarchy-shell codeep.agent toggle      # open, close, show, hide, toggle, refresh
```

## Settings

They live in the widget's entry in `~/.config/omarchy/shell.json`. Set one with
`omarchy bar set codeep.agent <key> <value>` (add `--json` for a number or a
boolean). A value of the wrong kind falls back to the default.

| Key | Default | What it does |
|---|---|---|
| `unattended` | `false` | **Run unattended (`--yolo`).** A prompt typed in the Ask field starts `codeep --yolo -- "<prompt>"`: Codeep runs without stopping to ask. Off by default; the panel says so in the urgent colour while it is on. A bare launch (right click) is always an ordinary session. If the work folder does not exist, an unattended run is **not started** (the panel says why and keeps your text); it never falls back to your home folder with `--yolo`. |
| `workDir` | `~/Work` | The folder Codeep starts in. Not found, an ordinary run starts in your home folder and an unattended one is refused. |
| `hideWhenIdle` | `false` | Take the mark off the bar while no Codeep runs. `omarchy-shell codeep.agent toggle` still opens the panel. |
| `refreshIntervalSec` | `60` | How often usage is read while the panel is open (15 to 3600). |
| `statusIntervalSec` | `3` | How often to look for running Codeep (1 to 60). |
| `animate` | `true` | Step the mark while Codeep works. Off holds one chevron lit instead. |
| `codeepPath` | | The Codeep binary, when it is not on the shell's PATH or in `~/.local/share/mise/shims`, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`. Not a mise shim or launcher script: those are never run in the background (see below). |

```bash
omarchy bar set codeep.agent unattended true --json
omarchy bar set codeep.agent workDir ~/Code
```

## What it reads, and what it never does

It reads:

- `$XDG_STATE_HOME/codeep/sessions/*.json` (default `~/.local/state/codeep/`),
  the small files Codeep 3.11 keeps while it runs: pid, project, state, a short
  task label, provider and model. No prompt, answer, command or file content is
  in them.
- `/proc`, to see which pids are alive (and `/proc/self/status` for its own uid).
- What `codeep --version` and `codeep usage --json` print. Usage comes through
  that command and nothing else: the plugin never opens Codeep's ledger or its
  configuration.
- The first 512 bytes of each `codeep` it finds, to tell a real binary from a
  launcher script (below), and `/proc/<pid>/stat` and `/proc/<pid>/cmdline` of
  the processes that have a status file, to tell Codeep from a process that was
  handed its number.
- Its own settings, the PATH of the shell it runs in, and `HOME`.

It starts these processes, each with an argument vector, never a shell string,
one at a time and under `timeout`: `find` (the status directory, `/proc`, and
where `codeep` lives), `head -c 512` on what it found, `mise which codeep` when
only mise launchers were found, `codeep --version`, `codeep usage --json`,
`test -d` on the work folder, and `omarchy-launch-tui` when you launch Codeep.
Every Codeep and mise it runs in the background gets `MISE_OFFLINE=1` and
auto-install off.

It never:

- opens a network connection itself, or runs anything that would: a mise shim,
  or the script `omarchy-mise-install` leaves in `~/.local/bin` (it runs
  `mise use -g` and `mise x`, which fetch Codeep from GitHub), is never run by
  a background probe. When only such a launcher exists, the panel says Codeep
  is not set up yet; Ask Codeep then starts the launcher, in a terminal, where
  its install shows;
- writes a file, not even in its own folder (which would make the shell reload
  it);
- reads an API key, a token or Codeep's configuration;
- puts text it did not write itself through a shell, a login shell, `bar.run`
  or `Util.execArgv`;
- changes `shell.json` or any setting by itself;
- sends a prompt anywhere but to the terminal you asked for.

Codeep, which it runs, keeps its record for Omarchy's own Agents panel up to
date when it spends tokens; `codeep --version` and `codeep usage --json` do not
touch it.

### What it does not trust

A status file can be stale, truncated, someone else's, hostile or enormous; the
output of `codeep` is only as good as the binary found on PATH.

- A status file is opened only if it is a regular file (not a symlink, FIFO or
  directory), named `<pid>.json`, no bigger than 16 KB, owned by you, and its
  process is alive. A 5 MB file or a symlink to `/etc/passwd` is never read.
  The document must be `schemaVersion` 1, its `pid` must be the one in its
  name, its `state` one of the four, and every string is cleaned.
- A live pid is also checked to be the process that wrote the file: a file
  survives a reboot, and its number may belong to something else since. The
  rule is Codeep's own: the process started after the file says its owner did,
  and its command line does not say `codeep`. Such a file is not listed.
  (A stepped clock makes a live Codeep look late, so a command line that says
  `codeep` always wins.)
- Everything shown from a file or from the model — project, task, provider,
  model names — is plain text: control and bidirectional characters removed,
  one line, shortened. Never markup, never part of a command.
- `usage` is only run after `codeep --version` says 3.11.0 or later, because
  Codeep before that ignores words it does not know — `codeep usage --json`
  would start the chat. Its answer must be `schemaVersion` 1 and under 256 KB.
- A missing or old Codeep is one line with the command to run
  (`omarchy-mise-install github:VladoIvankovic/Codeep codeep`, `mup`). The bar
  mark still shows.
- Every process is single-flight, under `timeout`, and stopped when the widget
  is.

### One quirk it works around

`omarchy-launch-tui` runs the terminal through `uwsm-app` and `systemd-run`,
which treat `$` in a command word the way systemd treats it in a unit file:
`$$` becomes `$`, `${HOME}` is replaced by its value, and a word starting with
`$NAME` is replaced or dropped. A prompt such as `$HOME is not set` would reach
Codeep without its first word. The plugin writes every `$` as `$$` on the way
in, so Codeep gets exactly what you typed. (`omarchy agent prompt` has the same
effect on its own prompts; that is Omarchy's, and left alone here.)

## Good to know

- The bar creates one widget per monitor, and each looks for running Codeep on
  its own timer, about 3 ms of work every 3 seconds. Several monitors, several
  of those; the process list is the same.
- A Codeep that was killed (SIGKILL) leaves its file; the mark treats it as
  gone as soon as its pid is, or as soon as the number belongs to another
  process (checked at every scan). Codeep removes the file itself the next time
  it starts.
- The shell's reduced-motion switch (`omarchy toggle animations`) is honoured on
  Omarchy versions that have it; 4.0.4 has not, and there the `animate` setting
  is the control. The animation is about two steps a second, only while Codeep
  works and the mark is visible, and nothing moves otherwise; without it,
  "working" is one chevron lit and three dimmed.
- With several Codeep running, the bar shows the most urgent state: waiting,
  then working, then idle.

## Troubleshooting

| The panel says | What to do |
|---|---|
| Codeep is not installed. Install it: omarchy-mise-install github:VladoIvankovic/Codeep codeep | Run that. If it is installed somewhere unusual, set `codeepPath`. |
| Codeep is not set up yet: run codeep once in a terminal | Only the mise launcher was found. Run `codeep` once (Ask Codeep does it): mise installs the real binary. |
| The work folder ~/Work does not exist, so an unattended run was not started | Create the folder, or `omarchy bar set codeep.agent workDir <folder>`. |
| Codeep 3.10.2 is too old: usage needs 3.11.0 or later. Update it: mup | Run `mup`. |
| Codeep usage failed / printed something unexpected | Run `codeep usage --json` in a terminal and look. |
| No Codeep running, but one is | Turn on **Share live status with Omarchy plugins** in Codeep's `/settings`. |

## Development

```bash
node --test test/*.test.mjs     # the decision logic (Model.js) and the package's promises
test/harness/run.sh             # on an Omarchy machine: the scanner and the Codeep probe, live
omarchy plugin validate .
```

`Model.js` holds every decision as plain functions with no Qt, so it runs under
Node. `SessionScanner.qml` and `CodeepCli.qml` are the only parts that start
anything. `Logo.qml` and `Mascot.qml` draw the artwork as shapes; a test keeps
their path data and `assets/*.svg` equal.

On Omarchy 4.0.4 a saved change to a plugin's QML is not picked up by the
running shell: it reloads the plugin but keeps the compiled component, because
the call it relies on to clear the cache (`Qt.clearComponentCache`) does not
exist in Quickshell 0.3.1. `omarchy-restart-shell` does it.

## License

Apache-2.0, as Codeep. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
