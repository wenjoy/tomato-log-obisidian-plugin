# Changelog

All notable changes to **Tomato Countdown** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-03

The statistics release. Tomato Countdown stops being just a timer and starts showing where your focus time actually goes.

### Highlights

- **A statistics view** with Day, Week, Month, and Task tabs — a year contribution grid, bar charts, a quality breakdown, and per-task tables.
- **A today summary** in the timer panel, so the current day's tomato count and quality are visible without opening anything.
- **A calmer interruption flow** — logging a distraction no longer cuts the session short, and tomato quality is now derived from how often you got interrupted.
- **System notifications** — the OS tells you when a tomato ends, so you can focus in another app.

### Added

- Statistics view (`Open tomato statistics` command and a **Statistics** button in the timer panel) with:
  - a year contribution grid on the Day tab, shaded by daily tomato count (`0`, `1–3`, `4–6`, `7–9`, `10+`);
  - vertical bar charts for the Week and Month tabs;
  - overview metrics per selected period: tomatoes, interruptions, completed, abandoned;
  - a quality breakdown (🙂 / 🙁 / 🤢) with percentages;
  - per-task tables with tomatoes, good / bad / rotten counts, and interruptions;
  - an overall Task tab listing every task in the log.
- Clickable heatmap cells and bars for switching the selected period, plus a **Refresh** button that re-reads the log.
- Today summary line in the timer panel (`Today: n 🍅 · good/bad/rotten`).
- Running tomato counter per task, appended to each log heading.
- System notifications for finished and abandoned tomatoes through the Web Notifications API.
- A 10-second in-app notice when a tomato completes.

### Changed

- Interrupting a running tomato now records the distraction while the countdown keeps running, instead of ending the session.
- Tomato quality is computed from the interruption count (`0 → 🙂`, `1 → 🙁`, `2+ → 🤢`); abandoning is always 🤢.
- Abandoning asks for a reason and logs it under the record as `abandoned: <reason>`.
- The interruption dialog uses a multi-line field, submits with `Cmd/Ctrl + Enter`, and puts the text input above the buttons.
- Modal and panel wording tightened; focus is placed in the input field when a dialog opens.
- Log entries are written newest-first under a per-date heading, with date sections ordered newest-first.
- Recent tasks are one-click buttons in the timer panel instead of a dropdown, and are disabled while a session is active.
- The standalone Pause action is gone; the timer only stops when an abandon prompt is cancelled, and **Start** then resumes it.
- Notifications now go through the Web Notifications API only, so the plugin uses no Node.js or Electron APIs and stays installable on mobile.

### Fixed

- Interruption records no longer trigger a system notification.
- Notification permission is requested the first time a notification is sent, instead of failing silently.
- Assorted issues in the interruption and abandon flows, plus formatting cleanups.

### Removed

- Inline statistics blocks and `State` buttons previously written into the log file. Statistics now live in a dedicated view, and the leftovers are stripped from the log the next time statistics are refreshed.
- The per-session "feeling" prompt, replaced by tomato quality derived from interruptions.
- Direct Electron usage and the now-unused inline statistics modal.

## [0.1.0] - 2026-06-16

The initial release.

### Added

- A configurable tomato countdown (default 25 minutes) in a side panel, with ribbon icon and command palette entries.
- Task names with a 20-item history, suggested in the timer panel and in the start dialog.
- Start / pause / resume / abandon controls, with the active session persisted across restarts and reloads.
- Markdown logging: each session appends a timestamped line under a per-date heading in a log file in the vault, together with the session's status and note.
- A "feeling" prompt after a session, letting you record how the tomato felt.
- A system notification when a tomato completes.
- Settings for countdown duration, log file path, and clearing task history.

[0.2.0]: https://github.com/wenjoy/tomato-log-obisidian-plugin/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/wenjoy/tomato-log-obisidian-plugin/releases/tag/0.1.0
