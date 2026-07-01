import {
  App,
  Events,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_TOMATO_COUNTDOWN = "tomato-countdown-view";
const DEFAULT_DURATION_MINUTES = 25;
const MAX_HISTORY_ITEMS = 20;
const GOOD_TOMATO = "🙂";
const BAD_TOMATO = "🙁";
const ROTTEN_TOMATO = "🤢";

type TimerStatus = "idle" | "running" | "paused";
type TomatoQuality = typeof GOOD_TOMATO | typeof BAD_TOMATO | typeof ROTTEN_TOMATO;

interface Interrupt {
  reason: string;
  timestamp: number;
}

interface ElectronNotificationConstructor {
  isSupported(): boolean;
  new(options: { title: string; body?: string }): { show(): void };
}

interface TomatoCountdownSettings {
  durationMinutes: number;
  logFilePath: string;
  taskHistory: string[];
  activeSession: ActiveSession | null;
}

interface ActiveSession {
  taskName: string;
  startTimestamp: number;
  durationMs: number;
  remainingMs: number;
  status: TimerStatus;
  lastStartedTimestamp: number | null;
  interrupts: Interrupt[];
}

interface SessionRecord {
  startTimestamp: number;
  endTimestamp: number;
  taskName: string;
  durationMinutes: number;
  quality: TomatoQuality;
  interrupts: number;
  abandoned: boolean;
  note: string;
}

interface TaskStatistics {
  taskName: string;
  count: number;
  focusMinutes: number;
  interrupts: number;
}

interface DailyStatistics {
  date: string;
  records: SessionRecord[];
  totalSessions: number;
  completedCount: number;
  abandonedCount: number;
  goodCount: number;
  badCount: number;
  rottenCount: number;
  totalInterrupts: number;
  totalFocusMinutes: number;
  byTask: TaskStatistics[];
}

interface TodaySummary {
  date: string;
  totalSessions: number;
  goodCount: number;
  badCount: number;
  rottenCount: number;
  totalFocusMinutes: number;
  totalInterrupts: number;
}

const DEFAULT_SETTINGS: TomatoCountdownSettings = {
  durationMinutes: DEFAULT_DURATION_MINUTES,
  logFilePath: "Tomato Timer Log.md",
  taskHistory: [],
  activeSession: null,
};

export default class TomatoCountdownPlugin extends Plugin {
  settings: TomatoCountdownSettings;
  events = new Events();
  todaySummary: TodaySummary | null = null;
  private isAbandonPromptOpen = false;
  private isInterruptPromptOpen = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_TOMATO_COUNTDOWN, (leaf) => new TomatoCountdownView(leaf, this));

    this.addRibbonIcon("timer", "Tomato Countdown", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-tomato-countdown",
      name: "Open tomato countdown",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "start-tomato-countdown",
      name: "Start tomato countdown",
      callback: () => {
        void this.promptAndStart();
      },
    });

    this.addCommand({
      id: "interrupt-tomato-countdown",
      name: "Interrupt tomato countdown",
      checkCallback: (checking) => {
        if (!this.settings.activeSession || this.settings.activeSession.status !== "running") {
          return false;
        }

        if (!checking) {
          void this.interruptTimer();
        }

        return true;
      },
    });

    this.addCommand({
      id: "abandon-tomato-countdown",
      name: "Abandon tomato countdown",
      checkCallback: (checking) => {
        if (!this.settings.activeSession || this.settings.activeSession.status === "idle") {
          return false;
        }

        if (!checking) {
          void this.abandonTimer();
        }

        return true;
      },
    });

    this.addCommand({
      id: "show-tomato-statistics",
      name: "Show today's tomato statistics",
      callback: () => {
        void this.showStatistics(new Date());
      },
    });

    this.addSettingTab(new TomatoCountdownSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.handleTick(), 1000));
    this.handleTick();
    void this.refreshTodaySummary();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TOMATO_COUNTDOWN);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.durationMinutes = Math.max(1, Number(this.settings.durationMinutes) || DEFAULT_DURATION_MINUTES);
    this.settings.taskHistory = Array.isArray(this.settings.taskHistory) ? this.settings.taskHistory : [];
    if (this.settings.activeSession) {
      this.settings.activeSession.interrupts = Array.isArray(this.settings.activeSession.interrupts)
        ? this.settings.activeSession.interrupts
        : [];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TOMATO_COUNTDOWN)[0];

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open Tomato Countdown.");
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TOMATO_COUNTDOWN,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  async promptAndStart(): Promise<void> {
    const taskName = await new TaskNameModal(this.app, this.settings.taskHistory).openAndGetValue();

    if (!taskName) {
      return;
    }

    await this.startTimer(taskName);
    await this.activateView();
  }

  async startTimer(taskName?: string): Promise<void> {
    const current = this.settings.activeSession;

    if (current && current.status === "paused" && (!taskName || taskName === current.taskName)) {
      current.status = "running";
      current.lastStartedTimestamp = Date.now();
      await this.saveSettings();
      this.emitTimerChange();
      return;
    }

    if (current && current.status === "paused") {
      current.status = "running";
      current.lastStartedTimestamp = Date.now();
      await this.saveSettings();
      this.emitTimerChange();
      return;
    }

    const normalizedTaskName = (taskName ?? current?.taskName ?? "").trim();
    if (!normalizedTaskName) {
      await this.promptAndStart();
      return;
    }

    if (current && current.status === "running") {
      new Notice("A tomato countdown is already running.");
      return;
    }

    const durationMs = Math.max(1, this.settings.durationMinutes) * 60 * 1000;

    this.settings.activeSession = {
      taskName: normalizedTaskName,
      startTimestamp: Date.now(),
      durationMs,
      remainingMs: durationMs,
      status: "running",
      lastStartedTimestamp: Date.now(),
      interrupts: [],
    };

    await this.addTaskToHistory(normalizedTaskName);
    await this.saveSettings();
    this.emitTimerChange();
  }

  async interruptTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || session.status !== "running" || this.isInterruptPromptOpen) {
      return;
    }

    this.isInterruptPromptOpen = true;
    const reason = await new InterruptModal(this.app).openAndGetValue();
    this.isInterruptPromptOpen = false;

    const current = this.settings.activeSession;
    if (!current || current !== session) {
      return;
    }

    if (reason === null) {
      return;
    }

    const trimmedReason = reason.trim() || "unspecified";
    current.interrupts = [...(current.interrupts ?? []), { reason: trimmedReason, timestamp: Date.now() }];
    await this.saveSettings();
    this.emitTimerChange();
    this.notifySystem("Tomato countdown interrupted", trimmedReason);
    new Notice(`Interrupt logged: ${trimmedReason}`);
  }

  async abandonTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || this.isAbandonPromptOpen || this.isInterruptPromptOpen) {
      return;
    }

    this.updateRemainingTime(session);
    session.status = "paused";
    session.lastStartedTimestamp = null;
    await this.saveSettings();
    this.emitTimerChange();

    this.isAbandonPromptOpen = true;
    const reason = await new ReasonModal(this.app).openAndGetValue();
    this.isAbandonPromptOpen = false;

    if (!reason || this.settings.activeSession !== session) {
      return;
    }

    await this.recordSession(session, ROTTEN_TOMATO, Date.now(), reason);
    this.settings.activeSession = null;
    await this.saveSettings();
    await this.refreshTodaySummary();
    this.emitTimerChange();
    this.notifySystem("Tomato countdown abandoned", reason);
    new Notice("Tomato countdown abandoned.");
  }

  async completeTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session) {
      return;
    }

    session.remainingMs = 0;
    const endTimestamp = session.startTimestamp + session.durationMs;
    const interrupts = session.interrupts ?? [];
    const quality = qualityForInterrupts(interrupts.length);

    await this.recordSession(session, quality, endTimestamp, null);
    this.settings.activeSession = null;
    await this.saveSettings();
    await this.refreshTodaySummary();
    this.emitTimerChange();
    this.notifySystem("Tomato countdown finished", session.taskName);
    this.notifyFinished(session.taskName);
  }

  getRemainingMs(): number {
    const session = this.settings.activeSession;
    if (!session) {
      return Math.max(1, this.settings.durationMinutes) * 60 * 1000;
    }

    if (session.status === "running") {
      const elapsed = session.lastStartedTimestamp ? Date.now() - session.lastStartedTimestamp : 0;
      return Math.max(0, session.remainingMs - elapsed);
    }

    return Math.max(0, session.remainingMs);
  }

  getStatus(): TimerStatus {
    return this.settings.activeSession?.status ?? "idle";
  }

  getTaskName(): string {
    return this.settings.activeSession?.taskName ?? "";
  }

  getInterruptCount(): number {
    return this.settings.activeSession?.interrupts?.length ?? 0;
  }

  async showStatistics(date: Date): Promise<void> {
    const stats = await this.getDailyStatistics(date);
    if (stats.totalSessions === 0) {
      new Notice(`No tomato records for ${stats.date}.`);
      return;
    }

    new StatisticsModal(this.app, stats).open();
  }

  async getDailyStatistics(date: Date): Promise<DailyStatistics> {
    const dateStr = formatDateKey(date);
    const records = await this.readRecordsForDate(dateStr);

    const byTaskMap = new Map<string, TaskStatistics>();
    for (const record of records) {
      const taskStat = byTaskMap.get(record.taskName) ?? {
        taskName: record.taskName,
        count: 0,
        focusMinutes: 0,
        interrupts: 0,
      };
      taskStat.count += 1;
      taskStat.focusMinutes += record.durationMinutes;
      taskStat.interrupts += record.interrupts;
      byTaskMap.set(record.taskName, taskStat);
    }

    return {
      date: dateStr,
      records,
      totalSessions: records.length,
      completedCount: records.filter((record) => !record.abandoned).length,
      abandonedCount: records.filter((record) => record.abandoned).length,
      goodCount: records.filter((record) => record.quality === GOOD_TOMATO).length,
      badCount: records.filter((record) => record.quality === BAD_TOMATO).length,
      rottenCount: records.filter((record) => record.quality === ROTTEN_TOMATO).length,
      totalInterrupts: records.reduce((sum, record) => sum + record.interrupts, 0),
      totalFocusMinutes: records.reduce((sum, record) => sum + record.durationMinutes, 0),
      byTask: Array.from(byTaskMap.values()).sort((a, b) => b.count - a.count),
    };
  }

  async refreshTodaySummary(): Promise<void> {
    const stats = await this.getDailyStatistics(new Date());
    this.todaySummary = {
      date: stats.date,
      totalSessions: stats.totalSessions,
      goodCount: stats.goodCount,
      badCount: stats.badCount,
      rottenCount: stats.rottenCount,
      totalFocusMinutes: stats.totalFocusMinutes,
      totalInterrupts: stats.totalInterrupts,
    };
    this.emitTimerChange();
  }

  private handleTick(): void {
    const session = this.settings.activeSession;
    if (!session || session.status !== "running") {
      this.emitTimerChange();
      return;
    }

    if (this.getRemainingMs() <= 0) {
      void this.completeTimer();
      return;
    }

    this.emitTimerChange();
  }

  private updateRemainingTime(session: ActiveSession): void {
    if (session.status !== "running" || !session.lastStartedTimestamp) {
      return;
    }

    const elapsed = Date.now() - session.lastStartedTimestamp;
    session.remainingMs = Math.max(0, session.remainingMs - elapsed);
    session.lastStartedTimestamp = Date.now();
  }

  private async addTaskToHistory(taskName: string): Promise<void> {
    const normalizedTaskName = taskName.trim();
    if (!normalizedTaskName) {
      return;
    }

    this.settings.taskHistory = [
      normalizedTaskName,
      ...this.settings.taskHistory.filter((item) => item !== normalizedTaskName),
    ].slice(0, MAX_HISTORY_ITEMS);
  }

  private async recordSession(
    session: ActiveSession,
    quality: TomatoQuality,
    endTimestamp: number,
    abandonReason: string | null,
  ): Promise<void> {
    const focusedMs = Math.max(0, session.durationMs - session.remainingMs);
    const focusedMinutes = Math.max(1, Math.round(focusedMs / 60000));
    const interruptCount = (session.interrupts ?? []).length;
    const heading = `#### [${formatTime(session.startTimestamp)}-${formatTime(endTimestamp)}] ${session.taskName} (${focusedMinutes}m, ${quality}🍅, i${interruptCount})`;

    const contentLines: string[] = [];
    for (const interrupt of session.interrupts ?? []) {
      const reason = interrupt.reason.trim();
      if (reason) {
        contentLines.push(`- ${reason}`);
      }
    }
    if (abandonReason) {
      contentLines.push(`- abandoned: ${abandonReason}`);
    }

    const block = contentLines.length > 0 ? `${heading}\n${contentLines.join("\n")}` : heading;

    await this.appendLogLine(block);
  }

  private async readRecordsForDate(dateStr: string): Promise<SessionRecord[]> {
    const path = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return [];
    }

    const content = await this.app.vault.read(file);
    const blocks = splitDateBlocks(content);
    const block = blocks.find((item) => item.title === `# ${dateStr}`);
    if (!block) {
      return [];
    }

    return parseRecords(block.body, dateStr);
  }

  private async appendLogLine(line: string): Promise<void> {
    const path = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const dateTitle = getDateTitle(new Date());

    if (existingFile instanceof TFile) {
      const currentContent = await this.app.vault.read(existingFile);
      const nextContent = prependWithDateHeader(currentContent, dateTitle, line);
      await this.app.vault.modify(existingFile, nextContent);
      return;
    }

    await this.app.vault.create(path, `${dateTitle}\n${line}\n`);
  }

  private notifyFinished(taskName: string): void {
    new Notice(`Tomato countdown finished: ${taskName}`, 10000);
  }

  private notifySystem(title: string, body: string): void {
    const electronNotification = getElectronNotification();
    if (electronNotification?.isSupported()) {
      new electronNotification({
        title,
        body,
      }).show();
      return;
    }

    const notificationApi = window.Notification;
    if (!notificationApi) {
      return;
    }

    if (notificationApi.permission === "granted") {
      new notificationApi(title, { body });
      return;
    }

    if (notificationApi.permission === "default") {
      void notificationApi.requestPermission().then((permission) => {
        if (permission === "granted") {
          new notificationApi(title, { body });
        }
      });
    }
  }

  private emitTimerChange(): void {
    this.events.trigger("change");
  }
}

class InterruptModal extends Modal {
  private resolvePromise: (value: string | null) => void;
  private inputEl: HTMLTextAreaElement;
  private value: string | null = null;

  openAndGetValue(): Promise<string | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "What distracted you?" });
    contentEl.createEl("p", { text: "The timer keeps running. Log the interruption to track tomato quality." });

    new Setting(contentEl).setName("Distraction").addTextArea((text) => {
      this.inputEl = text.inputEl;
      text.setPlaceholder("Phone, email, colleague, ...");
      text.inputEl.addClass("tomato-countdown-interrupt-textarea");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          this.submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Log interrupt")
          .setCta()
          .onClick(() => this.submit());
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });

    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolvePromise?.(this.value);
  }

  private submit(): void {
    const reason = this.inputEl.value.trim();
    if (!reason) {
      new Notice("Enter what distracted you, or cancel.");
      return;
    }

    this.value = reason;
    this.close();
  }
}

class ReasonModal extends Modal {
  private resolvePromise: (value: string | null) => void;
  private inputEl: HTMLInputElement;
  private value: string | null = null;

  openAndGetValue(): Promise<string | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Why abandon the timer?" });

    new Setting(contentEl).setName("Reason").addText((text) => {
      this.inputEl = text.inputEl;
      text.setPlaceholder("Enter the reason");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          this.submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => this.submit());
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });

    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolvePromise?.(this.value);
  }

  private submit(): void {
    const reason = this.inputEl.value.trim();
    if (!reason) {
      new Notice("Enter a reason before abandoning.");
      return;
    }

    this.value = reason;
    this.close();
  }
}

class StatisticsModal extends Modal {
  private stats: DailyStatistics;

  constructor(app: App, stats: DailyStatistics) {
    super(app);
    this.stats = stats;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tomato-countdown-stats");

    contentEl.createEl("h2", { text: `Tomato statistics — ${this.stats.date}` });

    const summary = contentEl.createDiv({ cls: "tomato-countdown-stats-row" });
    summary.createEl("span", { text: `${this.stats.totalSessions} 🍅` });
    summary.createEl("span", { text: `${this.stats.totalFocusMinutes}m focused` });
    summary.createEl("span", { text: `${this.stats.totalInterrupts} interrupts` });

    const quality = contentEl.createDiv({ cls: "tomato-countdown-stats-row" });
    quality.createEl("span", { text: `${GOOD_TOMATO} ${this.stats.goodCount}` });
    quality.createEl("span", { text: `${BAD_TOMATO} ${this.stats.badCount}` });
    quality.createEl("span", { text: `${ROTTEN_TOMATO} ${this.stats.rottenCount}` });

    const completion = contentEl.createDiv({ cls: "tomato-countdown-stats-row" });
    completion.createEl("span", { text: `${this.stats.completedCount} completed` });
    completion.createEl("span", { text: `${this.stats.abandonedCount} abandoned` });

    if (this.stats.byTask.length > 0) {
      contentEl.createEl("h3", { text: "By task" });
      const list = contentEl.createDiv({ cls: "tomato-countdown-stats-tasks" });
      for (const task of this.stats.byTask) {
        const row = list.createDiv({ cls: "tomato-countdown-stats-task" });
        row.createEl("div", { text: task.taskName, cls: "tomato-countdown-stats-task-name" });
        row.createEl("div", {
          text: `${task.count} 🍅 · ${task.focusMinutes}m · ${task.interrupts} interrupts`,
          cls: "tomato-countdown-stats-task-meta",
        });
      }
    }

    if (this.stats.records.length > 0) {
      contentEl.createEl("h3", { text: "Records" });
      const records = contentEl.createDiv({ cls: "tomato-countdown-stats-records" });
      for (const record of this.stats.records) {
        const heading = `${formatTime(record.startTimestamp)}-${formatTime(record.endTimestamp)} ${record.taskName} (${record.durationMinutes}m, ${record.quality}🍅, i${record.interrupts})`;
        const recordEl = records.createDiv({ cls: "tomato-countdown-stats-record" });
        recordEl.createEl("div", { text: heading, cls: "tomato-countdown-stats-record-heading" });
        if (record.note) {
          recordEl.createEl("div", { text: record.note, cls: "tomato-countdown-stats-record-note" });
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TomatoCountdownView extends ItemView {
  private plugin: TomatoCountdownPlugin;
  private timeEl: HTMLElement;
  private statusEl: HTMLElement;
  private todaySummaryEl: HTMLElement;
  private taskInputEl: HTMLInputElement;
  private historyListEl: HTMLElement;
  private startButtonEl: HTMLButtonElement;
  private interruptButtonEl: HTMLButtonElement;
  private abandonButtonEl: HTMLButtonElement;
  private statsButtonEl: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, plugin: TomatoCountdownPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TOMATO_COUNTDOWN;
  }

  getDisplayText(): string {
    return "Tomato Countdown";
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("tomato-countdown-view");

    const timerPanel = container.createDiv({ cls: "tomato-countdown-panel" });
    this.timeEl = timerPanel.createDiv({ cls: "tomato-countdown-time" });
    this.statusEl = timerPanel.createDiv({ cls: "tomato-countdown-status" });
    this.todaySummaryEl = timerPanel.createDiv({ cls: "tomato-countdown-today" });

    const formPanel = container.createDiv({ cls: "tomato-countdown-panel tomato-countdown-form" });
    formPanel.createEl("label", { text: "Task name" });
    this.taskInputEl = formPanel.createEl("input", {
      attr: {
        type: "text",
        placeholder: "What are you focusing on?",
      },
    });

    const actionPanel = container.createDiv({ cls: "tomato-countdown-actions" });
    this.startButtonEl = actionPanel.createEl("button", { text: "Start" });
    this.interruptButtonEl = actionPanel.createEl("button", { text: "Interrupt" });
    this.abandonButtonEl = actionPanel.createEl("button", { text: "Abandon" });

    this.startButtonEl.addEventListener("click", () => {
      void this.plugin.startTimer(this.taskInputEl.value);
    });

    this.interruptButtonEl.addEventListener("click", () => {
      void this.plugin.interruptTimer();
    });

    this.abandonButtonEl.addEventListener("click", () => {
      void this.plugin.abandonTimer();
    });

    const historyPanel = container.createDiv({ cls: "tomato-countdown-history" });
    const historyHeader = historyPanel.createDiv({ cls: "tomato-countdown-history-header" });
    historyHeader.createDiv({ cls: "tomato-countdown-history-title", text: "Recent tasks" });
    this.statsButtonEl = historyHeader.createEl("button", {
      text: "Statistics",
      cls: "tomato-countdown-stats-button",
    });
    this.statsButtonEl.addEventListener("click", () => {
      void this.plugin.showStatistics(new Date());
    });
    this.historyListEl = historyPanel.createDiv({ cls: "tomato-countdown-history-list" });

    this.registerEvent(
      this.plugin.events.on("change", () => {
        this.render();
      }),
    );

    this.render();
    void this.plugin.refreshTodaySummary();
  }

  async onClose(): Promise<void> {
    this.containerEl.children[1].empty();
  }

  private render(): void {
    const remainingMs = this.plugin.getRemainingMs();
    const status = this.plugin.getStatus();
    const taskName = this.plugin.getTaskName();
    const interruptCount = this.plugin.getInterruptCount();

    this.timeEl.setText(formatClock(remainingMs));
    this.statusEl.setText(getStatusText(status, taskName, interruptCount));
    this.renderTodaySummary();

    if (taskName && document.activeElement !== this.taskInputEl) {
      this.taskInputEl.value = taskName;
    }

    this.renderHistory();

    this.taskInputEl.disabled = status !== "idle";
    this.startButtonEl.setText(status === "paused" ? "Resume" : "Start");
    this.startButtonEl.disabled = status === "running";
    this.interruptButtonEl.disabled = status !== "running";
    this.abandonButtonEl.disabled = status === "idle";
  }

  private renderTodaySummary(): void {
    const summary = this.plugin.todaySummary;
    if (!summary || summary.date !== formatDateKey(new Date())) {
      this.todaySummaryEl.setText("Today: —");
      return;
    }

    if (summary.totalSessions === 0) {
      this.todaySummaryEl.setText("Today: no tomatoes yet");
      return;
    }

    this.todaySummaryEl.setText(
      `Today: ${summary.totalSessions} 🍅 · ${summary.totalFocusMinutes}m · ${summary.goodCount}${GOOD_TOMATO} ${summary.badCount}${BAD_TOMATO} ${summary.rottenCount}${ROTTEN_TOMATO}`,
    );
  }

  private renderHistory(): void {
    this.historyListEl.empty();
    const canSelectTask = this.plugin.getStatus() === "idle";
    this.plugin.settings.taskHistory.forEach((taskName) => {
      const taskButton = this.historyListEl.createEl("button", {
        text: taskName,
      });
      taskButton.disabled = !canSelectTask;
      taskButton.addEventListener("click", () => {
        if (canSelectTask) {
          this.taskInputEl.value = taskName;
          this.taskInputEl.focus();
        }
      });
    });
  }
}

class TaskNameModal extends Modal {
  private history: string[];
  private taskInputEl: HTMLInputElement;
  private value: string | null = null;
  private resolvePromise: (value: string | null) => void;

  constructor(app: App, history: string[]) {
    super(app);
    this.history = history;
  }

  openAndGetValue(): Promise<string | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Start tomato countdown" });

    new Setting(contentEl).setName("Task name").addText((text) => {
      this.taskInputEl = text.inputEl;
      text.setPlaceholder("What are you focusing on?");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          this.submit();
        }
      });
    });

    if (this.history.length > 0) {
      new Setting(contentEl).setName("History").addDropdown((dropdown) => {
        dropdown.addOption("", "Select a previous task");
        this.history.forEach((taskName) => dropdown.addOption(taskName, taskName));
        dropdown.onChange((value) => {
          this.taskInputEl.value = value;
          this.taskInputEl.focus();
        });
      });
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Start")
          .setCta()
          .onClick(() => this.submit());
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });

    window.setTimeout(() => this.taskInputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolvePromise?.(this.value);
  }

  private submit(): void {
    const taskName = this.taskInputEl.value.trim();
    if (!taskName) {
      new Notice("Enter a task name before starting.");
      return;
    }

    this.value = taskName;
    this.close();
  }
}

class TomatoCountdownSettingTab extends PluginSettingTab {
  plugin: TomatoCountdownPlugin;

  constructor(app: App, plugin: TomatoCountdownPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Countdown duration")
      .setDesc("Duration in minutes for each tomato countdown.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_DURATION_MINUTES))
          .setValue(String(this.plugin.settings.durationMinutes))
          .onChange(async (value) => {
            const durationMinutes = Number(value);
            if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
              return;
            }

            this.plugin.settings.durationMinutes = Math.round(durationMinutes);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Log file path")
      .setDesc("Completed, interrupted, and abandoned countdowns are appended here.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.logFilePath)
          .setValue(this.plugin.settings.logFilePath)
          .onChange(async (value) => {
            this.plugin.settings.logFilePath = value.trim() || DEFAULT_SETTINGS.logFilePath;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Clear task history")
      .setDesc("Remove saved task name suggestions.")
      .addButton((button) => {
        button.setButtonText("Clear").onClick(async () => {
          this.plugin.settings.taskHistory = [];
          await this.plugin.saveSettings();
          this.display();
          this.plugin.events.trigger("change");
        });
      });
  }
}

function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getDateTitle(date: Date): string {
  return `# ${formatDateKey(date)}`;
}

function qualityForInterrupts(count: number): TomatoQuality {
  if (count >= 2) {
    return ROTTEN_TOMATO;
  }
  if (count === 1) {
    return BAD_TOMATO;
  }
  return GOOD_TOMATO;
}

function parseRecords(body: string, dateStr: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  let heading = "";
  let contentLines: string[] = [];

  const flush = () => {
    if (!heading) {
      return;
    }
    const record = parseRecord(heading, contentLines, dateStr);
    if (record) {
      records.push(record);
    }
    heading = "";
    contentLines = [];
  };

  for (const line of body.split("\n")) {
    if (/^#### \[\d{2}:\d{2}-\d{2}:\d{2}\]/.test(line)) {
      flush();
      heading = line;
      continue;
    }

    if (heading) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        contentLines.push(trimmed);
      } else if (trimmed.length > 0) {
        contentLines.push(trimmed);
      }
    }
  }

  flush();
  return records;
}

function parseRecord(heading: string, contentLines: string[], dateStr: string): SessionRecord | null {
  const match = heading.match(/^#### \[(\d{2}):(\d{2})-(\d{2}):(\d{2})\] (.+) \((\d+)m, (.)🍅, i(\d+)\)$/u);
  if (!match) {
    return null;
  }

  const startH = Number(match[1]);
  const startM = Number(match[2]);
  const endH = Number(match[3]);
  const endM = Number(match[4]);
  const taskName = match[5];
  const durationMinutes = Number(match[6]);
  const quality = match[7] as TomatoQuality;
  const interrupts = Number(match[8]);

  const dateParts = dateStr.split("-").map(Number);
  if (dateParts.length !== 3 || dateParts.some((part) => Number.isNaN(part))) {
    return null;
  }

  const [year, month, day] = dateParts;
  const startTimestamp = new Date(year, month - 1, day, startH, startM).getTime();
  const endTimestamp = new Date(year, month - 1, day, endH, endM).getTime();

  const abandoned = contentLines.some((line) => line.replace(/^-\s*/, "").startsWith("abandoned:"));
  const note = contentLines.join("\n");

  return {
    startTimestamp,
    endTimestamp,
    taskName,
    durationMinutes,
    quality,
    interrupts,
    abandoned,
    note,
  };
}

function getElectronNotification(): ElectronNotificationConstructor | null {
  try {
    if (typeof require !== "function") {
      return null;
    }

    const electron = require("electron") as { Notification?: ElectronNotificationConstructor };
    return electron.Notification ?? null;
  } catch {
    return null;
  }
}

function prependWithDateHeader(currentContent: string, dateTitle: string, line: string): string {
  const trimmed = currentContent.trimEnd();

  if (trimmed.length === 0) {
    return `${dateTitle}\n${line}\n`;
  }

  const blocks = splitDateBlocks(trimmed);
  const currentBlockIndex = blocks.findIndex((block) => block.title === dateTitle);
  const existingCurrentBlock = currentBlockIndex >= 0 ? blocks.splice(currentBlockIndex, 1)[0] : null;
  const currentBody = existingCurrentBlock?.body.trim();
  const currentBlock = currentBody ? `${dateTitle}\n${line}\n${currentBody}` : `${dateTitle}\n${line}`;
  const rest = blocks
    .map((block) => block.raw.trim())
    .filter(Boolean)
    .join("\n\n");

  return rest ? `${currentBlock}\n\n${rest}\n` : `${currentBlock}\n`;
}

function splitDateBlocks(content: string): { title: string; body: string; raw: string }[] {
  const lines = content.split("\n");
  const blocks: { title: string; body: string; raw: string }[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentTitle && currentLines.length === 0) {
      return;
    }

    const raw = currentLines.join("\n");
    blocks.push({
      title: currentTitle,
      body: currentTitle ? currentLines.slice(1).join("\n") : raw,
      raw,
    });
  };

  for (const contentLine of lines) {
    if (/^# \d{4}-\d{2}-\d{2}$/.test(contentLine.trim())) {
      flush();
      currentTitle = contentLine.trim();
      currentLines = [currentTitle];
      continue;
    }

    currentLines.push(contentLine);
  }

  flush();
  return blocks;
}

function getStatusText(status: TimerStatus, taskName: string, interruptCount: number): string {
  if (status === "running") {
    return taskName ? `Running: ${taskName}` : "Running";
  }

  if (status === "paused") {
    if (interruptCount > 0) {
      return taskName ? `Interrupted (${interruptCount}): ${taskName}` : `Interrupted (${interruptCount})`;
    }
    return taskName ? `Stopped: ${taskName}` : "Stopped";
  }

  return "Ready";
}
