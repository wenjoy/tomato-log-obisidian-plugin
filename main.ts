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
const VIEW_TYPE_TOMATO_STATISTICS = "tomato-statistics-view";
const DEFAULT_DURATION_MINUTES = 25;
const MAX_HISTORY_ITEMS = 20;
const GOOD_TOMATO = "🙂";
const BAD_TOMATO = "🙁";
const ROTTEN_TOMATO = "🤢";

type TimerStatus = "idle" | "running" | "paused";
type TomatoQuality = typeof GOOD_TOMATO | typeof BAD_TOMATO | typeof ROTTEN_TOMATO;
type StatisticsRange = "day" | "week" | "month" | "task";

interface Interrupt {
  reason: string;
  timestamp: number;
}

interface TomatoCountdownSettings {
  durationMinutes: number;
  logFilePath: string;
  taskHistory: string[];
  activeSession: ActiveSession | null;
}

interface ActiveSession {
  taskName: string;
  taskCount: number;
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

interface TaskTableRow extends TaskStatistics {
  goodCount: number;
  badCount: number;
  rottenCount: number;
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

interface PeriodStatistics {
  title: string;
  sortKey: string;
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

interface StatisticsDataset {
  overall: PeriodStatistics;
  day: PeriodStatistics[];
  week: PeriodStatistics[];
  month: PeriodStatistics[];
  task: PeriodStatistics[];
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
    this.registerView(VIEW_TYPE_TOMATO_STATISTICS, (leaf) => new TomatoStatisticsView(leaf, this));

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
      name: "Open tomato statistics",
      callback: () => {
        void this.openStatisticsView();
      },
    });

    this.addSettingTab(new TomatoCountdownSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.handleTick(), 1000));
    this.handleTick();
    void this.refreshTodaySummary();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.durationMinutes = Math.max(1, Number(this.settings.durationMinutes) || DEFAULT_DURATION_MINUTES);
    this.settings.taskHistory = Array.isArray(this.settings.taskHistory) ? this.settings.taskHistory : [];
    if (this.settings.activeSession) {
      this.settings.activeSession.interrupts = Array.isArray(this.settings.activeSession.interrupts)
        ? this.settings.activeSession.interrupts
        : [];
      this.settings.activeSession.taskName = normalizeTaskName(this.settings.activeSession.taskName);
      this.settings.activeSession.taskCount =
        Math.max(1, Number(this.settings.activeSession.taskCount)) ||
        (await this.getCompletedTaskCount(this.settings.activeSession.taskName)) + 1;
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

    const normalizedTaskName = normalizeTaskName(taskName ?? current?.taskName ?? "");
    if (!normalizedTaskName) {
      await this.promptAndStart();
      return;
    }

    if (current && current.status === "running") {
      new Notice("A tomato countdown is already running.");
      return;
    }

    const durationMs = Math.max(1, this.settings.durationMinutes) * 60 * 1000;
    const taskCount = (await this.getCompletedTaskCount(normalizedTaskName)) + 1;

    this.settings.activeSession = {
      taskName: normalizedTaskName,
      taskCount,
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

  getTaskCount(): number {
    return this.settings.activeSession?.taskCount ?? 0;
  }

  async openStatisticsView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TOMATO_STATISTICS)[0];

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_TOMATO_STATISTICS,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async getStatisticsDataset(): Promise<StatisticsDataset | null> {
    const logPath = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const logFile = this.app.vault.getAbstractFileByPath(logPath);
    if (!(logFile instanceof TFile)) {
      new Notice(`Tomato log file not found: ${logPath}`);
      return null;
    }

    const logContent = await this.app.vault.process(logFile, (data) => removeObsoleteInlineStatistics(data));

    const recordsByDate = readAllRecordsByDate(logContent);
    const records = Array.from(recordsByDate.values()).flat();
    if (records.length === 0) {
      new Notice(`No tomato records found in ${logPath}.`);
      return null;
    }

    return buildStatisticsDataset(recordsByDate);
  }

  async getDailyStatistics(date: Date): Promise<DailyStatistics> {
    const dateStr = formatDateKey(date);
    const records = await this.readRecordsForDate(dateStr);

    return this.buildDailyStatistics(dateStr, records);
  }

  private buildDailyStatistics(dateStr: string, records: SessionRecord[]): DailyStatistics {
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
      byTask: Array.from(byTaskMap.values()).sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        if (b.interrupts !== a.interrupts) {
          return b.interrupts - a.interrupts;
        }
        return a.taskName.localeCompare(b.taskName);
      }),
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
    const normalizedTaskName = normalizeTaskName(taskName);
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
    const heading = `#### [${formatTime(session.startTimestamp)}-${formatTime(endTimestamp)}] (${quality}🍅, ${focusedMinutes}m)-${session.taskName}-${session.taskCount}`;

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
    return readRecordsForDateFromContent(content, dateStr);
  }

  private async getCompletedTaskCount(taskName: string): Promise<number> {
    const normalizedTaskName = normalizeTaskName(taskName);
    if (!normalizedTaskName) {
      return 0;
    }

    const path = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return 0;
    }

    const content = await this.app.vault.read(file);
    return Array.from(readAllRecordsByDate(content).values())
      .flat()
      .filter((record) => normalizeTaskName(record.taskName) === normalizedTaskName).length;
  }

  private async appendLogLine(line: string): Promise<void> {
    const path = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const dateTitle = getDateTitle(new Date());

    if (existingFile instanceof TFile) {
      await this.app.vault.process(existingFile, (data) => prependWithDateHeader(data, dateTitle, line));
      return;
    }

    await this.app.vault.create(path, `${dateTitle}\n${line}\n`);
  }

  private notifyFinished(taskName: string): void {
    new Notice(`Tomato countdown finished: ${taskName}`, 10000);
  }

  private notifySystem(title: string, body: string): void {
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

class TomatoStatisticsView extends ItemView {
  private plugin: TomatoCountdownPlugin;
  private activeRange: StatisticsRange = "day";
  private dataset: StatisticsDataset | null = null;
  private rootEl: HTMLElement;
  private selectedPeriodKeys: Record<StatisticsRange, string | null> = {
    day: null,
    week: null,
    month: null,
    task: null,
  };

  constructor(leaf: WorkspaceLeaf, plugin: TomatoCountdownPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TOMATO_STATISTICS;
  }

  getDisplayText(): string {
    return "Tomato Statistics";
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("tomato-statistics-view");
    this.rootEl = container.createDiv({ cls: "tomato-statistics-content" });
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.containerEl.children[1].empty();
  }

  private async refresh(): Promise<void> {
    this.rootEl.empty();
    this.rootEl.createDiv({ cls: "tomato-statistics-loading", text: "Loading statistics..." });
    this.dataset = await this.plugin.getStatisticsDataset();
    this.render();
  }

  private render(): void {
    this.rootEl.empty();

    const header = this.rootEl.createDiv({ cls: "tomato-statistics-header" });
    header.createEl("h2", { text: "Tomato Statistics" });
    header.createEl("button", { text: "Refresh" }).addEventListener("click", () => {
      void this.refresh();
    });

    if (!this.dataset) {
      this.rootEl.createDiv({ cls: "tomato-statistics-empty", text: "No tomato records found." });
      return;
    }

    const periods = this.dataset[this.activeRange];
    const selectedPeriod = this.getSelectedPeriod(periods);

    this.renderTabs(this.rootEl);
    if (this.activeRange === "task") {
      this.renderOverview(this.rootEl, this.dataset.overall);
      this.renderTaskStatisticsTable(this.rootEl, periods);
      return;
    }

    if (this.activeRange === "day") {
      this.renderContributionGraph(this.rootEl, periods, selectedPeriod);
    } else {
      this.renderPeriodChart(this.rootEl, periods, selectedPeriod);
    }
    this.renderOverview(this.rootEl, selectedPeriod);
    this.renderQualityChart(this.rootEl, selectedPeriod);
    this.renderTaskChart(this.rootEl, selectedPeriod);
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "tomato-statistics-tabs" });
    const tabItems: { value: StatisticsRange; label: string }[] = [
      { value: "day", label: "Day" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month" },
      { value: "task", label: "Task" },
    ];

    for (const tab of tabItems) {
      const button = tabs.createEl("button", {
        text: tab.label,
        cls: this.activeRange === tab.value ? "is-active" : "",
        attr: { type: "button" },
      });
      button.addEventListener("click", () => {
        this.activeRange = tab.value;
        this.render();
      });
    }
  }

  private renderOverview(container: HTMLElement, stats: PeriodStatistics): void {
    const metrics = container.createDiv({ cls: "tomato-statistics-metrics" });
    this.renderMetric(metrics, "Tomatoes", String(stats.totalSessions));
    this.renderMetric(metrics, "Interrupts", String(stats.totalInterrupts));
    this.renderMetric(metrics, "Completed", String(stats.completedCount));
    this.renderMetric(metrics, "Abandoned", String(stats.abandonedCount));
  }

  private renderMetric(container: HTMLElement, label: string, value: string): void {
    const metric = container.createDiv({ cls: "tomato-statistics-metric" });
    metric.createDiv({ cls: "tomato-statistics-metric-value", text: value });
    metric.createDiv({ cls: "tomato-statistics-metric-label", text: label });
  }

  private renderContributionGraph(container: HTMLElement, periods: PeriodStatistics[], selectedPeriod: PeriodStatistics): void {
    const panel = container.createDiv({ cls: "tomato-statistics-panel" });
    panel.createEl("h3", { text: "Tomato contribution" });
    const graph = panel.createDiv({ cls: "tomato-statistics-contribution-graph" });
    const months = buildContributionMonths(periods);

    for (const month of months) {
      const row = graph.createDiv({ cls: "tomato-statistics-contribution-month" });
      row.createDiv({ cls: "tomato-statistics-contribution-month-label", text: month.label });
      const cells = row.createDiv({ cls: "tomato-statistics-contribution-month-cells" });
      for (const day of month.days) {
        const button = cells.createEl("button", {
          cls: `tomato-statistics-contribution-cell tomato-statistics-contribution-level-${getContributionLevel(day.totalSessions)}`,
          attr: {
            type: "button",
            title: formatPeriodTooltip(day),
          },
        });
        if (day.sortKey === selectedPeriod.sortKey) {
          button.addClass("is-selected");
        }
        button.addEventListener("click", () => {
          this.selectedPeriodKeys.day = day.sortKey;
          this.render();
        });
      }
    }

    const footer = panel.createDiv({ cls: "tomato-statistics-contribution-footer" });
    footer.createSpan({ text: "Less" });
    const levelLabels = ["0", "1-3", "4-6", "7-9", "10+"];
    for (let level = 0; level <= 4; level += 1) {
      footer.createSpan({
        cls: `tomato-statistics-contribution-swatch tomato-statistics-contribution-level-${level}`,
        attr: { title: `${levelLabels[level]} tomatoes` },
      });
    }
    footer.createSpan({ text: "More" });
  }

  private renderPeriodChart(container: HTMLElement, periods: PeriodStatistics[], selectedPeriod: PeriodStatistics): void {
    const panel = container.createDiv({ cls: "tomato-statistics-panel" });
    panel.createEl("h3", { text: `Tomatoes by ${this.activeRange}` });
    const chart = panel.createDiv({ cls: "tomato-statistics-vertical-chart" });
    const maxTomatoes = Math.max(1, ...periods.map((period) => period.totalSessions));

    for (const period of periods) {
      this.renderVerticalBar(chart, period, maxTomatoes, period.sortKey === selectedPeriod.sortKey);
    }
  }

  private renderQualityChart(container: HTMLElement, stats: PeriodStatistics): void {
    const panel = container.createDiv({ cls: "tomato-statistics-panel" });
    panel.createEl("h3", { text: `Quality · ${stats.title}` });

    const total = Math.max(1, stats.totalSessions);
    const good = (stats.goodCount / total) * 100;
    const bad = (stats.badCount / total) * 100;
    const rotten = (stats.rottenCount / total) * 100;
    const pieWrap = panel.createDiv({ cls: "tomato-statistics-pie-wrap" });
    pieWrap
      .createDiv({ cls: "tomato-statistics-pie" })
      .setAttr(
        "style",
        `background: conic-gradient(var(--tomato-chart-good) 0 ${good}%, var(--tomato-chart-bad) ${good}% ${
          good + bad
        }%, var(--tomato-chart-rotten) ${good + bad}% ${good + bad + rotten}%);`,
      );
    const legend = pieWrap.createDiv({ cls: "tomato-statistics-pie-legend" });
    this.renderPieLegendItem(legend, "good", `${GOOD_TOMATO} Good`, stats.goodCount, good);
    this.renderPieLegendItem(legend, "bad", `${BAD_TOMATO} Bad`, stats.badCount, bad);
    this.renderPieLegendItem(legend, "rotten", `${ROTTEN_TOMATO} Rotten`, stats.rottenCount, rotten);
  }

  private renderTaskChart(container: HTMLElement, stats: PeriodStatistics): void {
    const panel = container.createDiv({ cls: "tomato-statistics-panel" });
    panel.createEl("h3", { text: `Tasks · ${stats.title}` });
    const table = panel.createEl("table", { cls: "tomato-statistics-task-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Task" });
    headerRow.createEl("th", { text: "Tomatoes" });
    headerRow.createEl("th", { text: "Good" });
    headerRow.createEl("th", { text: "Bad" });
    headerRow.createEl("th", { text: "Rotten" });
    headerRow.createEl("th", { text: "Interrupts" });

    const tbody = table.createEl("tbody");
    for (const task of buildTaskTableRows(stats.records)) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: task.taskName });
      row.createEl("td", { text: String(task.count) });
      row.createEl("td", { text: String(task.goodCount) });
      row.createEl("td", { text: String(task.badCount) });
      row.createEl("td", { text: String(task.rottenCount) });
      row.createEl("td", { text: String(task.interrupts) });
    }
  }

  private renderTaskStatisticsTable(container: HTMLElement, tasks: PeriodStatistics[]): void {
    const panel = container.createDiv({ cls: "tomato-statistics-panel" });
    panel.createEl("h3", { text: "Task statistics" });
    const table = panel.createEl("table", { cls: "tomato-statistics-task-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Task" });
    headerRow.createEl("th", { text: "Tomatoes" });
    headerRow.createEl("th", { text: "Good" });
    headerRow.createEl("th", { text: "Bad" });
    headerRow.createEl("th", { text: "Rotten" });
    headerRow.createEl("th", { text: "Interrupts" });

    const tbody = table.createEl("tbody");
    for (const task of tasks) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: task.title });
      row.createEl("td", { text: String(task.totalSessions) });
      row.createEl("td", { text: String(task.goodCount) });
      row.createEl("td", { text: String(task.badCount) });
      row.createEl("td", { text: String(task.rottenCount) });
      row.createEl("td", { text: String(task.totalInterrupts) });
    }
  }

  private renderVerticalBar(
    container: HTMLElement,
    period: PeriodStatistics,
    maxValue: number,
    selected: boolean,
  ): void {
    const button = container.createEl("button", {
      cls: selected ? "tomato-statistics-vertical-item is-selected" : "tomato-statistics-vertical-item",
      attr: {
        type: "button",
        title: formatPeriodTooltip(period),
      },
    });
    button.addEventListener("click", () => {
      this.selectedPeriodKeys[this.activeRange] = period.sortKey;
      this.render();
    });

    button.createDiv({ cls: "tomato-statistics-vertical-value", text: String(period.totalSessions) });
    const track = button.createDiv({ cls: "tomato-statistics-vertical-track" });
    track
      .createDiv({ cls: "tomato-statistics-vertical-fill" })
      .setAttr("style", `height: ${Math.max(4, (period.totalSessions / maxValue) * 100)}%`);
    button.createDiv({ cls: "tomato-statistics-vertical-label", text: shortPeriodLabel(period.title, this.activeRange) });
    button.createDiv({ cls: "tomato-statistics-vertical-meta", text: `${period.totalInterrupts}i` });
  }

  private renderPieLegendItem(
    container: HTMLElement,
    quality: string,
    label: string,
    count: number,
    percent: number,
  ): void {
    const item = container.createDiv({ cls: "tomato-statistics-pie-legend-item" });
    item.createSpan({ cls: `tomato-statistics-pie-dot tomato-statistics-pie-dot-${quality}` });
    item.createSpan({ text: `${label}: ${count} (${Math.round(percent)}%)` });
  }

  private getSelectedPeriod(periods: PeriodStatistics[]): PeriodStatistics {
    const selectedKey = this.selectedPeriodKeys[this.activeRange];
    const selectedPeriod = periods.find((period) => period.sortKey === selectedKey) ?? periods[0];
    this.selectedPeriodKeys[this.activeRange] = selectedPeriod.sortKey;
    return selectedPeriod;
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

    const statisticsPanel = container.createDiv({ cls: "tomato-countdown-panel tomato-countdown-statistics-panel" });
    statisticsPanel.createDiv({ cls: "tomato-countdown-history-title", text: "Statistics" });
    this.statsButtonEl = statisticsPanel.createEl("button", {
      text: "Statistics",
      cls: "tomato-countdown-stats-button",
    });
    this.statsButtonEl.addEventListener("click", () => {
      void this.plugin.openStatisticsView();
    });

    const historyPanel = container.createDiv({ cls: "tomato-countdown-history" });
    const historyHeader = historyPanel.createDiv({ cls: "tomato-countdown-history-header" });
    historyHeader.createDiv({ cls: "tomato-countdown-history-title", text: "Recent tasks" });
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
    const taskCount = this.plugin.getTaskCount();

    this.timeEl.setText(formatClock(remainingMs));
    this.statusEl.setText(getStatusText(status, taskName, interruptCount, taskCount));
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
      `Today: ${summary.totalSessions} 🍅 · ${summary.goodCount}${GOOD_TOMATO} ${summary.badCount}${BAD_TOMATO} ${summary.rottenCount}${ROTTEN_TOMATO}`,
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

function normalizeTaskName(taskName: string): string {
  return taskName.trim().replace(/\s+/g, " ");
}

function stripTaskCountSuffix(taskName: string): string {
  return taskName.replace(/-\d+$/, "");
}

function countInterruptLines(contentLines: string[]): number {
  return contentLines.filter((line) => {
    const normalized = line.replace(/^-\s*/, "");
    return normalized.length > 0 && !normalized.startsWith("abandoned:");
  }).length;
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

function readRecordsForDateFromContent(content: string, dateStr: string): SessionRecord[] {
  const blocks = splitDateBlocks(content);
  const block = blocks.find((item) => item.title === `# ${dateStr}`);
  if (!block) {
    return [];
  }

  return parseRecords(block.body, dateStr);
}

function readAllRecordsByDate(content: string): Map<string, SessionRecord[]> {
  const recordsByDate = new Map<string, SessionRecord[]>();
  for (const block of splitDateBlocks(content)) {
    const dateMatch = block.title.match(/^# (\d{4}-\d{2}-\d{2})$/);
    if (!dateMatch) {
      continue;
    }

    const records = parseRecords(block.body, dateMatch[1]);
    if (records.length > 0) {
      recordsByDate.set(dateMatch[1], records);
    }
  }

  return recordsByDate;
}

function parseRecord(heading: string, contentLines: string[], dateStr: string): SessionRecord | null {
  const newMatch = heading.match(/^#### \[(\d{2}):(\d{2})-(\d{2}):(\d{2})\] \((.)🍅, (\d+)m\)-(.+)$/u);
  const newWithInterruptMatch = heading.match(
    /^#### \[(\d{2}):(\d{2})-(\d{2}):(\d{2})\] \((.)🍅, (\d+)m, i(\d+)\)-(.+)$/u,
  );
  const oldMatch = heading.match(/^#### \[(\d{2}):(\d{2})-(\d{2}):(\d{2})\] (.+) \((\d+)m, (.)🍅, i(\d+)\)$/u);
  const match = newMatch ?? newWithInterruptMatch ?? oldMatch;
  if (!match) {
    return null;
  }

  const startH = Number(match[1]);
  const startM = Number(match[2]);
  const endH = Number(match[3]);
  const endM = Number(match[4]);
  const isNewFormat = match === newMatch;
  const isNewWithInterruptFormat = match === newWithInterruptMatch;
  const taskName = normalizeTaskName(stripTaskCountSuffix(isNewFormat ? match[7] : isNewWithInterruptFormat ? match[8] : match[5]));
  const durationMinutes = Number(match[6]);
  const quality = (isNewFormat || isNewWithInterruptFormat ? match[5] : match[7]) as TomatoQuality;
  const interrupts = isNewFormat ? countInterruptLines(contentLines) : Number(isNewWithInterruptFormat ? match[7] : match[8]);

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

function prependWithDateHeader(currentContent: string, dateTitle: string, line: string): string {
  const trimmed = removeObsoleteInlineStatistics(currentContent).trimEnd();

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

function removeObsoleteInlineStatistics(content: string): string {
  return content
    .replace(/<!-- tomato-statistics:start -->[\s\S]*?<!-- tomato-statistics:end -->\n*/g, "")
    .replace(/^\s*<button\b[^\n]*\bdata-tomato-statistics-date="[^"]+"[^\n]*>State<\/button>\s*\n?/gm, "");
}

function buildStatisticsDataset(recordsByDate: Map<string, SessionRecord[]>): StatisticsDataset {
  const sortedDates = Array.from(recordsByDate.keys()).sort((a, b) => b.localeCompare(a));
  const allRecords = sortedDates.flatMap((date) => recordsByDate.get(date) ?? []);

  return {
    overall: buildPeriodStatistics("All records", "all", allRecords),
    day: sortedDates.map((date) => buildPeriodStatistics(date, date, recordsByDate.get(date) ?? [])),
    week: buildGroupedPeriodStatistics(recordsByDate, getWeekKey, getWeekTitle),
    month: buildGroupedPeriodStatistics(recordsByDate, getMonthKey, (key) => key),
    task: buildTaskPeriodStatistics(allRecords),
  };
}

function buildContributionMonths(periods: PeriodStatistics[]): { label: string; days: PeriodStatistics[] }[] {
  if (periods.length === 0) {
    return [];
  }

  const periodsByDate = new Map(periods.map((period) => [period.sortKey, period]));
  const sortedKeys = periods.map((period) => period.sortKey).sort();
  const latestDate = parseDateKey(sortedKeys[sortedKeys.length - 1]);
  if (!latestDate) {
    return [{ label: "", days: periods.slice().sort((a, b) => a.sortKey.localeCompare(b.sortKey)) }];
  }

  const year = latestDate.getFullYear();
  const months: { label: string; days: PeriodStatistics[] }[] = [];
  for (let month = 0; month < 12; month += 1) {
    const days: PeriodStatistics[] = [];
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0);
    for (const date = new Date(start); date.getTime() <= end.getTime(); date.setDate(date.getDate() + 1)) {
      const dateKey = formatDateKey(date);
      days.push(periodsByDate.get(dateKey) ?? buildPeriodStatistics(dateKey, dateKey, []));
    }
    months.push({
      label: start.toLocaleString(undefined, { month: "short" }),
      days,
    });
  }

  return months;
}

function getContributionLevel(count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (count <= 3) {
    return 1;
  }
  if (count <= 6) {
    return 2;
  }
  if (count <= 9) {
    return 3;
  }
  return 4;
}

function buildTaskPeriodStatistics(records: SessionRecord[]): PeriodStatistics[] {
  const grouped = new Map<string, SessionRecord[]>();
  for (const record of records) {
    grouped.set(record.taskName, [...(grouped.get(record.taskName) ?? []), record]);
  }

  return Array.from(grouped.entries())
    .map(([taskName, taskRecords]) => buildPeriodStatistics(taskName, taskName, taskRecords))
    .sort((a, b) => {
      if (b.totalSessions !== a.totalSessions) {
        return b.totalSessions - a.totalSessions;
      }
      return a.title.localeCompare(b.title);
    });
}

function buildTaskTableRows(records: SessionRecord[]): TaskTableRow[] {
  const taskMap = new Map<string, TaskTableRow>();
  for (const record of records) {
    const task = taskMap.get(record.taskName) ?? {
      taskName: record.taskName,
      count: 0,
      focusMinutes: 0,
      interrupts: 0,
      goodCount: 0,
      badCount: 0,
      rottenCount: 0,
    };
    task.count += 1;
    task.focusMinutes += record.durationMinutes;
    task.interrupts += record.interrupts;
    if (record.quality === GOOD_TOMATO) {
      task.goodCount += 1;
    } else if (record.quality === BAD_TOMATO) {
      task.badCount += 1;
    } else if (record.quality === ROTTEN_TOMATO) {
      task.rottenCount += 1;
    }
    taskMap.set(record.taskName, task);
  }

  return sortTaskStatistics(Array.from(taskMap.values())) as TaskTableRow[];
}

function buildGroupedPeriodStatistics(
  recordsByDate: Map<string, SessionRecord[]>,
  getKey: (dateStr: string) => string,
  getTitle: (key: string) => string,
): PeriodStatistics[] {
  const grouped = new Map<string, SessionRecord[]>();
  for (const [dateStr, records] of recordsByDate) {
    const key = getKey(dateStr);
    grouped.set(key, [...(grouped.get(key) ?? []), ...records]);
  }

  return Array.from(grouped.entries())
    .map(([key, records]) => buildPeriodStatistics(getTitle(key), key, records))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

function buildPeriodStatistics(title: string, sortKey: string, records: SessionRecord[]): PeriodStatistics {
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
    title,
    sortKey,
    records,
    totalSessions: records.length,
    completedCount: records.filter((record) => !record.abandoned).length,
    abandonedCount: records.filter((record) => record.abandoned).length,
    goodCount: records.filter((record) => record.quality === GOOD_TOMATO).length,
    badCount: records.filter((record) => record.quality === BAD_TOMATO).length,
    rottenCount: records.filter((record) => record.quality === ROTTEN_TOMATO).length,
    totalInterrupts: records.reduce((sum, record) => sum + record.interrupts, 0),
    totalFocusMinutes: records.reduce((sum, record) => sum + record.durationMinutes, 0),
    byTask: sortTaskStatistics(Array.from(byTaskMap.values())),
  };
}

function sortTaskStatistics(tasks: TaskStatistics[]): TaskStatistics[] {
  return tasks.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (b.interrupts !== a.interrupts) {
      return b.interrupts - a.interrupts;
    }
    return a.taskName.localeCompare(b.taskName);
  });
}

function parseDateKey(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function getWeekKey(dateStr: string): string {
  const date = parseDateKey(dateStr);
  if (!date) {
    return dateStr;
  }

  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return formatDateKey(date);
}

function getWeekTitle(weekStartKey: string): string {
  const start = parseDateKey(weekStartKey);
  if (!start) {
    return weekStartKey;
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${weekStartKey} to ${formatDateKey(end)}`;
}

function shortPeriodLabel(title: string, range: StatisticsRange): string {
  if (range === "week") {
    return title.replace(/\d{4}-/g, "");
  }
  if (range === "month") {
    return title.slice(5);
  }
  return title;
}

function formatPeriodTooltip(period: PeriodStatistics): string {
  return [
    period.title,
    `${period.totalSessions} tomatoes`,
    `${period.totalInterrupts} interrupts`,
    `${period.completedCount} completed`,
    `${period.abandonedCount} abandoned`,
    `${period.goodCount}${GOOD_TOMATO} ${period.badCount}${BAD_TOMATO} ${period.rottenCount}${ROTTEN_TOMATO}`,
  ].join("\n");
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

function getStatusText(status: TimerStatus, taskName: string, interruptCount: number, taskCount: number): string {
  const taskText = taskName && taskCount > 0 ? `${taskName} - ${taskCount}` : taskName;
  if (status === "running") {
    return taskText ? `Running: ${taskText}` : "Running";
  }

  if (status === "paused") {
    if (interruptCount > 0) {
      return taskText ? `Interrupted (${interruptCount}): ${taskText}` : `Interrupted (${interruptCount})`;
    }
    return taskText ? `Stopped: ${taskText}` : "Stopped";
  }

  return "Ready";
}
