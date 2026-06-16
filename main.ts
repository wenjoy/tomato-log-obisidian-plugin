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

type TimerStatus = "idle" | "running" | "paused";
type RecordStatus = "done" | "interrupted";

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
  private isAbandonPromptOpen = false;
  private isCompletionPromptOpen = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_TOMATO_COUNTDOWN,
      (leaf) => new TomatoCountdownView(leaf, this),
    );

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
      id: "pause-tomato-countdown",
      name: "Pause tomato countdown",
      checkCallback: (checking) => {
        if (!this.settings.activeSession || this.settings.activeSession.status !== "running") {
          return false;
        }

        if (!checking) {
          void this.pauseTimer();
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

    this.addSettingTab(new TomatoCountdownSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.handleTick(), 1000));
    this.handleTick();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TOMATO_COUNTDOWN);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.durationMinutes = Math.max(1, Number(this.settings.durationMinutes) || DEFAULT_DURATION_MINUTES);
    this.settings.taskHistory = Array.isArray(this.settings.taskHistory) ? this.settings.taskHistory : [];
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
    };

    await this.addTaskToHistory(normalizedTaskName);
    await this.saveSettings();
    this.emitTimerChange();
  }

  async pauseTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || session.status !== "running") {
      return;
    }

    this.updateRemainingTime(session);
    session.status = "paused";
    session.lastStartedTimestamp = null;
    await this.saveSettings();
    this.emitTimerChange();
  }

  async abandonTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || this.isAbandonPromptOpen) {
      return;
    }

    this.updateRemainingTime(session);
    this.isAbandonPromptOpen = true;
    const reason = await new ReasonModal(this.app).openAndGetValue();
    this.isAbandonPromptOpen = false;

    if (!reason || this.settings.activeSession !== session) {
      return;
    }

    await this.recordSession(session, "interrupted", Date.now(), `rotten tomato - ${reason}`);
    this.settings.activeSession = null;
    await this.saveSettings();
    this.emitTimerChange();
    this.notifySystem("Tomato countdown abandoned", reason);
    new Notice("Tomato countdown abandoned.");
  }

  async completeTimer(): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || this.isCompletionPromptOpen) {
      return;
    }

    this.isCompletionPromptOpen = true;
    const feeling = await new FeelingModal(this.app).openAndGetValue();
    this.isCompletionPromptOpen = false;

    if (this.settings.activeSession !== session) {
      return;
    }

    const endTimestamp = session.startTimestamp + session.durationMs;
    await this.recordSession(session, "done", endTimestamp, `pretty tomato 🍅 - ${feeling}`);
    this.settings.activeSession = null;
    await this.saveSettings();
    this.emitTimerChange();
    this.notifySystem("Tomato countdown finished", feeling);
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

  async setTaskName(taskName: string): Promise<void> {
    const session = this.settings.activeSession;
    if (!session || session.status !== "paused") {
      return;
    }

    const normalizedTaskName = taskName.trim();
    if (!normalizedTaskName) {
      return;
    }

    session.taskName = normalizedTaskName;
    await this.addTaskToHistory(normalizedTaskName);
    await this.saveSettings();
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
    status: RecordStatus,
    endTimestamp: number,
    note: string,
  ): Promise<void> {
    const line = `${formatTime(session.startTimestamp)}-${formatTime(endTimestamp)} ${session.taskName} (${status}: ${note})`;

    await this.appendLogLine(line);
  }

  private async appendLogLine(line: string): Promise<void> {
    const path = this.settings.logFilePath.trim() || DEFAULT_SETTINGS.logFilePath;
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const datedLine = `${getDateTitle(new Date())}\n${line}`;

    if (existingFile instanceof TFile) {
      const currentContent = await this.app.vault.read(existingFile);
      const nextContent = appendWithDateHeader(currentContent, datedLine);
      await this.app.vault.modify(existingFile, nextContent);
      return;
    }

    await this.app.vault.create(path, `${datedLine}\n`);
  }

  private notifyFinished(taskName: string): void {
    new Notice(`Tomato countdown finished: ${taskName}`, 10000);
  }

  private notifySystem(title: string, body: string): void {
    const notificationApi = window.Notification;
    if (!notificationApi) {
      return;
    }

    const send = () => {
      new notificationApi(title, { body });
    };

    if (notificationApi.permission === "granted") {
      send();
      return;
    }

    if (notificationApi.permission === "default") {
      void notificationApi.requestPermission().then((permission) => {
        if (permission === "granted") {
          send();
        }
      });
    }
  }

  private emitTimerChange(): void {
    this.events.trigger("change");
  }
}

class FeelingModal extends Modal {
  private resolvePromise: (value: string) => void;
  private feeling = "not recorded";

  openAndGetValue(): Promise<string> {
    this.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "How did it go?" });
    contentEl.createEl("p", { text: "Pick a feeling for this finished tomato." });

    const buttons = contentEl.createDiv({ cls: "tomato-countdown-actions" });

    const goodButton = buttons.createEl("button", { text: "🙂 Good" });
    const badButton = buttons.createEl("button", { text: "🙁 Bad" });
    const skipButton = buttons.createEl("button", { text: "Skip" });

    goodButton.addEventListener("click", () => {
      this.feeling = "🙂 good";
      this.close();
    });

    badButton.addEventListener("click", () => {
      this.feeling = "🙁 bad";
      this.close();
    });

    skipButton.addEventListener("click", () => {
      this.feeling = "not recorded";
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolvePromise?.(this.feeling);
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

    new Setting(contentEl)
      .setName("Reason")
      .addText((text) => {
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
        button
          .setButtonText("Cancel")
          .onClick(() => this.close());
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

class TomatoCountdownView extends ItemView {
  private plugin: TomatoCountdownPlugin;
  private timeEl: HTMLElement;
  private statusEl: HTMLElement;
  private taskInputEl: HTMLInputElement;
  private historySelectEl: HTMLSelectElement;
  private startButtonEl: HTMLButtonElement;
  private pauseButtonEl: HTMLButtonElement;
  private abandonButtonEl: HTMLButtonElement;

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

    const formPanel = container.createDiv({ cls: "tomato-countdown-panel tomato-countdown-form" });
    formPanel.createEl("label", { text: "Task name" });
    this.taskInputEl = formPanel.createEl("input", {
      attr: {
        type: "text",
        placeholder: "What are you focusing on?",
      },
    });

    formPanel.createEl("label", { text: "History" });
    this.historySelectEl = formPanel.createEl("select");
    this.historySelectEl.addEventListener("change", () => {
      this.taskInputEl.value = this.historySelectEl.value;
    });

    const actionPanel = container.createDiv({ cls: "tomato-countdown-actions" });
    this.startButtonEl = actionPanel.createEl("button", { text: "Start" });
    this.pauseButtonEl = actionPanel.createEl("button", { text: "Stop" });
    this.abandonButtonEl = actionPanel.createEl("button", { text: "Abandon" });

    this.startButtonEl.addEventListener("click", () => {
      void this.plugin.startTimer(this.taskInputEl.value);
    });

    this.pauseButtonEl.addEventListener("click", () => {
      void this.plugin.pauseTimer();
    });

    this.abandonButtonEl.addEventListener("click", () => {
      void this.plugin.abandonTimer();
    });

    const historyPanel = container.createDiv({ cls: "tomato-countdown-history" });
    historyPanel.createDiv({ cls: "tomato-countdown-history-title", text: "Recent tasks" });
    const historyList = historyPanel.createDiv({ cls: "tomato-countdown-history-list" });

    this.plugin.settings.taskHistory.forEach((taskName) => {
      const taskButton = historyList.createEl("button", { text: taskName });
      taskButton.addEventListener("click", () => {
        this.taskInputEl.value = taskName;
      });
    });

    this.registerEvent(
      this.plugin.events.on("change", () => {
        this.render();
      }),
    );

    this.render();
  }

  async onClose(): Promise<void> {
    this.containerEl.children[1].empty();
  }

  private render(): void {
    const remainingMs = this.plugin.getRemainingMs();
    const status = this.plugin.getStatus();
    const taskName = this.plugin.getTaskName();

    this.timeEl.setText(formatClock(remainingMs));
    this.statusEl.setText(getStatusText(status, taskName));

    if (taskName && document.activeElement !== this.taskInputEl) {
      this.taskInputEl.value = taskName;
    }

    this.renderHistorySelect();

    this.taskInputEl.disabled = status === "running";
    this.startButtonEl.setText(status === "paused" ? "Resume" : "Start");
    this.startButtonEl.disabled = status === "running";
    this.pauseButtonEl.disabled = status !== "running";
    this.abandonButtonEl.disabled = status === "idle";
  }

  private renderHistorySelect(): void {
    const selectedValue = this.historySelectEl.value;
    this.historySelectEl.empty();
    this.historySelectEl.createEl("option", {
      text: "Select a previous task",
      value: "",
    });

    this.plugin.settings.taskHistory.forEach((taskName) => {
      this.historySelectEl.createEl("option", {
        text: taskName,
        value: taskName,
      });
    });

    this.historySelectEl.value = this.plugin.settings.taskHistory.includes(selectedValue) ? selectedValue : "";
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

    new Setting(contentEl)
      .setName("Task name")
      .addText((text) => {
        this.taskInputEl = text.inputEl;
        text.setPlaceholder("What are you focusing on?");
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            this.submit();
          }
        });
      });

    if (this.history.length > 0) {
      new Setting(contentEl)
        .setName("History")
        .addDropdown((dropdown) => {
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
        button
          .setButtonText("Cancel")
          .onClick(() => this.close());
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
      .setDesc("Completed and abandoned countdowns are appended here.")
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
        button
          .setButtonText("Clear")
          .onClick(async () => {
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

function getDateTitle(date: Date): string {
  return `# ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function appendWithDateHeader(currentContent: string, datedLine: string): string {
  const trimmed = currentContent.trimEnd();
  const currentDate = getDateTitle(new Date());
  const line = datedLine.split("\n")[1];

  if (trimmed.length === 0) {
    return `${datedLine}\n`;
  }

  if (trimmed.split("\n").some((contentLine) => contentLine.trim() === currentDate)) {
    return `${trimmed}\n${line}\n`;
  }

  return `${trimmed}\n\n${datedLine}\n`;
}

function getStatusText(status: TimerStatus, taskName: string): string {
  if (status === "running") {
    return taskName ? `Running: ${taskName}` : "Running";
  }

  if (status === "paused") {
    return taskName ? `Stopped: ${taskName}` : "Stopped";
  }

  return "Ready";
}
