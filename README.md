# Tomato Countdown

A Pomodoro-style tomato timer for [Obsidian](https://obsidian.md) that keeps a plain-Markdown log of every session, so your focus time, interruptions, and task history stay in your vault instead of a separate app.

Start a 25-minute tomato, get interrupted, log what pulled you away, and watch the day's totals and long-term trends build up — all from a side panel, all stored as text you can read, edit, and search.

## Features

- **Countdown timer built for note-taking** — runs in a side panel next to your notes, with start / resume / interrupt / abandon controls.
- **Task-aware sessions** — every tomato is tagged with a task name; the 20 most recent task names are suggested in the panel and in the start dialog.
- **Interruption logging that doesn't stop the clock** — when something distracts you, log the reason and keep focusing. The reason is written into your log.
- **Honest tomato quality** — tomatoes are rated 🙂 (no interruptions), 🙁 (one interruption), or 🤢 (two or more, or abandoned mid-session).
- **Markdown log you own** — each finished tomato is prepended to a date-sectioned Markdown file in your vault, newest first.
- **Today at a glance** — the timer panel shows today's tomato count and quality breakdown.
- **Statistics view** — Day / Week / Month / Task tabs with a year contribution grid, bar charts, a quality breakdown, and per-task tables.
- **Survives restarts** — an active session is persisted and keeps counting from real timestamps, not tick counts.
- **System notifications** — desktop notifications when a tomato finishes or is abandoned.
- **Works on desktop and mobile** (`isDesktopOnly: false`).

## Installation

### From a release (manual)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/wenjoy/tomato-log-obisidian-plugin/releases).
2. Create the folder `<your-vault>/.obsidian/plugins/tomato-countdown/`.
3. Copy the three files into that folder.
4. In Obsidian, open **Settings → Community plugins**, reload the plugin list, and enable **Tomato Countdown**.

### With BRAT

1. Install and enable the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Run **BRAT: Add a beta plugin for testing** and enter `wenjoy/tomato-log-obisidian-plugin`.
3. Enable **Tomato Countdown** in **Settings → Community plugins**.

## Getting started

1. Click the timer icon in the ribbon, or run **Tomato Countdown: Open tomato countdown** from the command palette. The panel opens in the right sidebar.
2. Type a task name (for example `write release notes`) and press **Start**.
3. If something interrupts you, press **Interrupt** and describe what happened. The countdown keeps running.
4. Let the timer reach zero, or press **Abandon** to stop early and record why.

When the countdown hits zero, the tomato is logged automatically, a system notification fires, and the panel returns to idle.

Interruptions are cheap to log: press `Cmd/Ctrl + Enter` in the interruption dialog, or `Enter` in the abandon reason field.

## Interrupt, pause, or abandon

| Action | What happens |
| --- | --- |
| **Interrupt** | Records a distraction with a reason. The clock keeps running; the tomato's quality drops as interruptions accumulate. |
| **Abandon** | Stops the clock, asks for a reason, and logs the session as 🤢 (rotten), including the partial focus time. |
| Cancel an abandon prompt | The clock stays stopped (`Stopped`, or `Interrupted (n)` if you already logged distractions). **Start** becomes **Resume**, which continues from the remaining time. |

Tomato quality is derived from the interruption count at completion: `0 → 🙂`, `1 → 🙁`, `2+ → 🤢`. Abandoned tomatoes are always 🤢.

## The Markdown log

Every record is written to the log file configured in settings (default: `Tomato Timer Log.md` at the vault root). The file is organised by date; a new day's section is created at the top, and each new record is inserted right below its date heading, so the newest record is always first.

```markdown
# 2026-07-08
#### [13:40-14:05] (🙂🍅, 25m)-write release notes-3
#### [11:02-11:09] (🤢🍅, 7m)-refactor log parser-2
- abandoned: client meeting moved up
#### [09:15-09:40] (🤢🍅, 25m)-refactor log parser-1
- Slack notification
- Email
```

Each record is a level-4 heading, optionally followed by bullet lines:

```
#### [<start>-<end>] (<quality>🍅, <minutes>m)-<task name>-<count>
```

- `<start>-<end>` — local wall-clock time of the session.
- `<quality>` — the tomato rating described above.
- `<minutes>` — minutes actually spent focusing (a completed tomato logs the full duration; an abandoned one logs the elapsed portion, minimum 1 minute).
- `<task name>` — the normalised task you typed.
- `<count>` — which tomato this is for that task across the whole log (a running counter, stripped when statistics are computed).

Bullet lines under the heading are the interruptions (and an `abandoned: <reason>` line for abandoned sessions). A clean tomato has no bullets.

Because the log is plain text, you can edit, reorder, or delete entries; statistics re-read the file on every refresh. Older heading variants written by previous versions — including the form that stored the interruption count inline — are still parsed. Refreshing statistics also removes leftover inline statistics blocks and `State` buttons written by earlier builds.

## Statistics view

Open it with the **Statistics** button in the timer panel or **Tomato Countdown: Open tomato statistics**. The view reads the log file and supports four tabs:

| Tab | What you see |
| --- | --- |
| **Day** | A year contribution grid (one cell per day across the 12 months of the year your latest entry falls in, shaded by tomato count: 0, 1–3, 4–6, 7–9, 10+) plus the selected day's metrics, quality breakdown, and per-task table. |
| **Week** | Vertical bars per week, with the same metrics and breakdowns for the selected week. |
| **Month** | Vertical bars per month, with the same metrics and breakdowns for the selected month. |
| **Task** | Overall totals plus one row per task: tomatoes, good / bad / rotten counts, and interruptions. |

Metrics shown for the selected period: tomatoes, interruptions, completed, and abandoned. Click any bar or heatmap cell to switch the period; **Refresh** re-reads the log.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| **Countdown duration** | `25` | Length of a tomato in minutes (minimum 1). |
| **Log file path** | `Tomato Timer Log.md` | Vault-relative path of the log file. Created automatically on the first record. |
| **Clear task history** | — | Removes the saved task-name suggestions. |

## Commands

| Command | ID | Notes |
| --- | --- | --- |
| Open tomato countdown | `open-tomato-countdown` | Opens or reveals the timer panel. |
| Start tomato countdown | `start-tomato-countdown` | Opens the task dialog, then starts and reveals the panel. |
| Interrupt tomato countdown | `interrupt-tomato-countdown` | Only available while a countdown is running. |
| Abandon tomato countdown | `abandon-tomato-countdown` | Only available while a countdown is running or paused. |
| Open tomato statistics | `show-tomato-statistics` | Opens or reveals the statistics view. |

## Notifications

Completion and abandonment trigger a system notification (Electron notification on desktop, falling back to the Web Notifications API). Completed tomatoes also show a 10-second in-app notice. Logging an interruption does not notify, since the timer keeps running.

On mobile, notification delivery depends on the platform's support for the Web Notifications API; the in-app notice always works.

## Data and privacy

- Plugin state (active session, settings, task history) lives in `data.json` inside the plugin folder.
- Session history lives in the Markdown log file in your vault.
- The plugin makes no network requests and collects no telemetry.

## Development

```bash
npm install       # install dependencies
npm run dev       # watch mode: rebuilds main.js on change
npm run build     # type-check, then produce a minified production bundle
```

Source layout:

| Path | Purpose |
| --- | --- |
| `main.ts` | Plugin entry point: timer state, log writer/parser, views, modals, settings tab. |
| `styles.css` | Styling for the timer panel and statistics view. |
| `main.js` | Generated bundle (gitignored); produce it with `npm run build`. |
| `manifest.json` | Plugin metadata and minimum Obsidian version. |
| `versions.json` | Version → minimum Obsidian version map. |

To test locally, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/tomato-countdown/` and reload the plugin.

## Compatibility

Requires Obsidian **1.5.0** or newer.

## Release notes

Version history and notable changes live in [CHANGELOG.md](CHANGELOG.md).

## License

Released under the [MIT License](LICENSE). © 2026 wenjoy
