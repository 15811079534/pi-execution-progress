import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Key, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type PhaseStatus = "pending" | "active" | "done" | "blocked";
type Activity = "ready" | "thinking" | "waiting for input" | string;

type Phase = {
	id: number;
	title: string;
	status: PhaseStatus;
	reason?: string;
};

type ProgressState = {
	title?: string;
	sourceDoc?: string;
	phases: Phase[];
};

type ProgressDetails = {
	action: ProgressAction;
	state: ProgressState;
	error?: string;
};

type ProgressAction = "set_plan" | "start" | "complete" | "block" | "resume" | "clear" | "show";

type ProgressParams = {
	action: ProgressAction;
	title?: string;
	sourceDoc?: string;
	phases?: string[];
	phase?: number;
	reason?: string;
};

const TOOL_NAME = "execution_progress";
const STATUS_KEY = "execution-progress";
const SHOW_SHORTCUT = Key.super("l");
const PANEL_BACKGROUND = "customMessageBg" as const;
const PANEL_BORDER = "borderMuted" as const;
const MAX_PHASES = 20;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

const ProgressParams = Type.Object({
	action: StringEnum(["set_plan", "start", "complete", "block", "resume", "clear", "show"] as const),
	title: Type.Optional(Type.String({ description: "Short execution title for the progress panel." })),
	sourceDoc: Type.Optional(Type.String({ description: "Path of the approved implementation document, for display only." })),
	phases: Type.Optional(
		Type.Array(Type.String({ minLength: 1, description: "One concise execution milestone." }), {
			maxItems: MAX_PHASES,
		}),
	),
	phase: Type.Optional(Type.Integer({ minimum: 1, description: "1-based phase id." })),
	reason: Type.Optional(Type.String({ description: "Why a phase is blocked." })),
});

const EMPTY_STATE: ProgressState = { phases: [] };

function cloneState(state: ProgressState): ProgressState {
	return {
		...(state.title ? { title: state.title } : {}),
		...(state.sourceDoc ? { sourceDoc: state.sourceDoc } : {}),
		phases: state.phases.map((phase) => ({ ...phase })),
	};
}

function normalizeState(value: unknown): ProgressState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { title?: unknown; sourceDoc?: unknown; phases?: unknown };
	if (!Array.isArray(candidate.phases)) return undefined;

	const phases: Phase[] = [];
	for (const [index, raw] of candidate.phases.entries()) {
		if (!raw || typeof raw !== "object") return undefined;
		const phase = raw as { id?: unknown; title?: unknown; status?: unknown; reason?: unknown };
		const id = typeof phase.id === "number" ? phase.id : index + 1;
		const status = phase.status;
		if (!Number.isInteger(id) || id < 1 || typeof phase.title !== "string") return undefined;
		if (status !== "pending" && status !== "active" && status !== "done" && status !== "blocked") return undefined;
		phases.push({
			id,
			title: phase.title,
			status,
			...(typeof phase.reason === "string" && phase.reason ? { reason: phase.reason } : {}),
		});
	}

	return {
		...(typeof candidate.title === "string" && candidate.title.trim() ? { title: candidate.title.trim() } : {}),
		...(typeof candidate.sourceDoc === "string" && candidate.sourceDoc.trim()
			? { sourceDoc: candidate.sourceDoc.trim() }
			: {}),
		phases,
	};
}

function stateFromBranch(ctx: ExtensionContext): ProgressState {
	let state = cloneState(EMPTY_STATE);
	for (const entry of ctx.sessionManager.getBranch()) {
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type === "custom" && candidate.customType === "execution-progress-state") {
			const restored = normalizeState((candidate.data as { state?: unknown } | undefined)?.state);
			if (restored) state = restored;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = message.details as Partial<ProgressDetails> | undefined;
		const restored = normalizeState(details?.state);
		if (restored) state = restored;
	}
	return state;
}

function phaseCount(state: ProgressState): { completed: number; total: number; active?: Phase } {
	const active = state.phases.find((phase) => phase.status === "active");
	return {
		completed: state.phases.filter((phase) => phase.status === "done").length,
		total: state.phases.length,
		...(active ? { active } : {}),
	};
}

function phaseMarker(status: PhaseStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "active":
			return "◐";
		case "blocked":
			return "!";
		default:
			return "○";
	}
}

type SummaryColor = "accent" | "success" | "warning" | "error" | "muted";
type ProgressSummary = {
	label: string;
	color: SummaryColor;
	completed: number;
	total: number;
	stage?: number;
	current?: Phase;
};

function displayActivity(activity: Activity): string {
	if (activity === "ready") return "等待开始";
	if (activity === "thinking") return "执行中";
	if (activity === "waiting for input") return "等待输入";
	if (activity.startsWith("running: ")) return `执行：${activity.slice("running: ".length)}`;
	if (activity.startsWith("error: ")) return `工具失败：${activity.slice("error: ".length)}`;
	if (activity.startsWith("blocked: ")) return "已阻塞";
	return activity;
}

function hasOpenPlan(state: ProgressState): boolean {
	return state.phases.some((phase) => phase.status !== "done");
}

function isImplementationTask(prompt: string): boolean {
	const normalized = prompt.trim().toLowerCase();
	if (!normalized || /^(怎么|如何|什么|为什么|是否|能否|请问|how|what|why|can you explain|is there)/i.test(normalized)) return false;
	return /(实现|修改|优化|修复|开发|重构|补充|调整|改成|新增|删除|测试|验收|implement|fix|refactor|add|change|build|test|update|optimi[sz]e|migrate|remove)/i.test(normalized);
}

function isMutatingToolCall(toolName: string, _input: unknown): boolean {
	return toolName === "edit" || toolName === "write";
}

function automaticFallbackPlan(): ProgressState {
	return {
		title: "自动执行进度",
		phases: [
			{ id: 1, title: "完成当前实现修改", status: "active" },
			{ id: 2, title: "执行定向验证", status: "pending" },
			{ id: 3, title: "整理测试与证据", status: "pending" },
			{ id: 4, title: "整理交付结果", status: "pending" }
		],
	};
}

function progressSummary(state: ProgressState, activity: Activity): ProgressSummary {
	const total = state.phases.length;
	const completed = state.phases.filter((phase) => phase.status === "done").length;
	const current = state.phases.find((phase) => phase.status === "active") ?? state.phases.find((phase) => phase.status === "blocked");

	if (total === 0) return { label: "未开始", color: "muted", completed: 0, total: 0 };
	if (completed >= total) return { label: "已完成", color: "success", completed: total, total, stage: total };
	if (current?.status === "blocked") {
		return { label: "已阻塞", color: "error", completed, total, stage: current.id, current };
	}
	if (activity === "waiting for input") {
		return { label: "等待输入", color: "warning", completed, total, stage: current?.id ?? Math.min(total, completed + 1), current };
	}
	if (current && activity === "ready") {
		return { label: "已暂停", color: "warning", completed, total, stage: current.id, current };
	}
	if (current) return { label: "执行中", color: "accent", completed, total, stage: current.id, current };
	return { label: "待开始", color: "muted", completed, total, stage: Math.min(total, completed + 1) };
}

class ProgressOverlay {
	private readonly getState: () => ProgressState;
	private readonly getActivity: () => Activity;
	private readonly getSpinnerFrame: () => string;
	private readonly theme: Theme;

	constructor(
		theme: Theme,
		getState: () => ProgressState,
		getActivity: () => Activity,
		getSpinnerFrame: () => string,
	) {
		this.theme = theme;
		this.getState = getState;
		this.getActivity = getActivity;
		this.getSpinnerFrame = getSpinnerFrame;
	}

	invalidate(): void {
		// Stateless rendering; the next render reads the latest snapshot.
	}

	private line(text: string, width: number, railColor: SummaryColor = "muted"): string {
		const contentWidth = Math.max(1, width - 2);
		const clipped = truncateToWidth(text, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.theme.bg(PANEL_BACKGROUND, `${this.theme.fg(railColor, "▌")} ${clipped}${padding}`);
	}

	private divider(width: number): string {
		const contentWidth = Math.max(1, width - 2);
		return this.theme.bg(PANEL_BACKGROUND, `  ${this.theme.fg(PANEL_BORDER, "─".repeat(contentWidth))}`);
	}

	private row(left: string, right: string | undefined, width: number, railColor: SummaryColor = "muted"): string {
		const contentWidth = Math.max(1, width - 2);
		if (!right) return this.line(left, width, railColor);
		const availableLeft = Math.max(1, contentWidth - visibleWidth(right) - 1);
		const clippedLeft = truncateToWidth(left, availableLeft, "…");
		const gap = Math.max(1, contentWidth - visibleWidth(clippedLeft) - visibleWidth(right));
		return this.line(`${clippedLeft}${" ".repeat(gap)}${right}`, width, railColor);
	}

	private progressBar(summary: ProgressSummary, width: number): string {
		const barWidth = Math.max(12, Math.min(34, width - 18));
		const ratio = summary.total === 0 || summary.label === "未开始" || summary.label === "待开始"
			? 0
			: summary.label === "已完成"
				? 1
				: Math.max(0, Math.min(1, ((summary.stage ?? summary.completed) - (summary.current ? 1 : 0)) / summary.total));
		const filled = Math.round(barWidth * ratio);
		return `${this.theme.fg(summary.color, "━".repeat(filled))}${this.theme.fg("dim", "╌".repeat(barWidth - filled))}`;
	}

	private phaseColor(status: PhaseStatus): SummaryColor {
		return status === "done" ? "success" : status === "active" ? "accent" : status === "blocked" ? "error" : "muted";
	}

	private styledPhase(phase: Phase): string {
		const markerColor = this.phaseColor(phase.status);
		const title = phase.status === "done" ? this.theme.strikethrough(this.theme.fg("dim", phase.title)) : phase.title;
		return `${this.theme.fg(markerColor, phaseMarker(phase.status))} ${phase.id}. ${title}`;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(28, Math.floor(width));
		const state = this.getState();
		const summary = progressSummary(state, this.getActivity());
		const title = state.title || "执行进度";
		const headerRight = summary.total > 0 ? `${summary.stage ?? summary.completed}/${summary.total}` : summary.label;
		const lines: string[] = [this.row(this.theme.bold(this.theme.fg("text", title)), this.theme.fg(summary.color, headerRight), safeWidth, summary.color)];

		if (summary.current) {
			const activityMarker = summary.label === "执行中" ? this.getSpinnerFrame() : phaseMarker(summary.current.status);
			lines.push(this.line(`${this.theme.bold(this.theme.fg(summary.color, `${activityMarker} ${summary.label}`))}`, safeWidth, summary.color));
			lines.push(this.line(`  ${summary.current.title}`, safeWidth, summary.color));
			lines.push(this.line(`${this.progressBar(summary, safeWidth)}  ${summary.completed}/${summary.total} 已完成`, safeWidth, summary.color));
		} else if (summary.total === 0) {
			lines.push(this.line(this.theme.fg("muted", "尚未建立执行阶段"), safeWidth));
			lines.push(this.line(this.theme.fg("dim", "等待执行计划"), safeWidth));
		} else {
			lines.push(this.line(this.theme.bold(this.theme.fg(summary.color, summary.label)), safeWidth, summary.color));
			lines.push(this.line(`${this.progressBar(summary, safeWidth)}  当前阶段待开始`, safeWidth, summary.color));
		}

		if (state.phases.length > 0) {
			lines.push(this.divider(safeWidth));
			for (const phase of state.phases) lines.push(this.line(this.styledPhase(phase), safeWidth, this.phaseColor(phase.status)));
		}
		return lines;
	}
}

export default function executionProgressExtension(pi: ExtensionAPI): void {
	let state = cloneState(EMPTY_STATE);
	let activity: Activity = "ready";
	let pendingResync = false;
	let overlay: ProgressOverlay | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let overlayVisible = false;
	let responsiveVisible = false;
	let overlayClosing = false;
	let overlayPromise: Promise<void> | undefined;
	let closeOverlay: (() => void) | undefined;
	let activeTui: TUI | undefined;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

	function stopSpinner(): void {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}

	function syncSpinner(): void {
		const shouldAnimate = overlayVisible && responsiveVisible && hasOpenPlan(state) && progressSummary(state, activity).label === "执行中";
		if (!shouldAnimate) {
			stopSpinner();
			return;
		}
		if (spinnerTimer) return;
		spinnerIndex = 0;
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			overlay?.invalidate();
			activeTui?.requestRender();
		}, 160);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const summary = progressSummary(state, activity);
		if (summary.total === 0 || !hasOpenPlan(state)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} else {
			const stageText = summary.current
				? `${summary.stage}/${summary.total} · ${summary.current.title}`
				: `${summary.completed}/${summary.total} · ${summary.label}`;
			ctx.ui.setStatus(STATUS_KEY, `${stageText} · ${displayActivity(activity)}`);
		}
		activeTui?.requestRender();
	}

	function refresh(ctx: ExtensionContext): void {
		updateStatus(ctx);
		syncSpinner();
		overlay?.invalidate();
		activeTui?.requestRender();
	}

	function persistManualState(): void {
		pi.appendEntry("execution-progress-state", { state: cloneState(state) });
	}

	async function createAutomaticFallbackPlan(ctx: ExtensionContext): Promise<void> {
		if (hasOpenPlan(state)) return;
		state = automaticFallbackPlan();
		activity = "thinking";
		persistManualState();
		await ensureOverlay(ctx);
		refresh(ctx);
	}

	function hideOverlay(): void {
		overlayVisible = false;
		overlayHandle?.setHidden(true);
		syncSpinner();
	}

	function showOverlay(): void {
		overlayVisible = true;
		overlayHandle?.setHidden(false);
		syncSpinner();
	}

	function releaseOverlay(): void {
		overlayVisible = false;
		responsiveVisible = false;
		stopSpinner();
		if (closeOverlay) {
			overlayClosing = true;
			closeOverlay();
		} else overlayHandle?.setHidden(true);
	}

	async function ensureOverlay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return;
		if (overlayPromise) {
			if (!overlayClosing) {
				showOverlay();
				return;
			}
			await overlayPromise;
		}

		const promise = ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					activeTui = tui;
					overlayVisible = true;
					closeOverlay = done;
					overlay = new ProgressOverlay(
						theme,
						() => state,
						() => activity,
						() => SPINNER_FRAMES[spinnerIndex],
					);
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						width: 58,
						minWidth: 48,
						margin: { top: 1, right: 2 },
						visible: (termWidth) => {
							responsiveVisible = termWidth >= 120;
							if (!responsiveVisible) stopSpinner();
							else syncSpinner();
							return responsiveVisible;
						},
						nonCapturing: true,
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			)
			.catch((error: unknown) => {
				console.warn(`[execution-progress] overlay unavailable: ${String(error)}`);
			})
			.finally(() => {
				overlayPromise = undefined;
				overlayClosing = false;
				responsiveVisible = false;
				overlay = undefined;
				overlayHandle = undefined;
				closeOverlay = undefined;
				activeTui = undefined;
			});
		overlayPromise = promise;
		void promise;
	}

	function restoreState(ctx: ExtensionContext): void {
		state = stateFromBranch(ctx);
		activity = "ready";
		refresh(ctx);
		if (hasOpenPlan(state)) void ensureOverlay(ctx);
		else releaseOverlay();
	}

	function errorResult(action: ProgressAction, message: string): { content: [{ type: "text"; text: string }]; details: ProgressDetails } {
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { action, state: cloneState(state), error: message },
		};
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Execution Progress",
		description: "Track a small set of execution milestones extracted from the approved implementation document.",
		promptSnippet: "Show and update the current execution milestone",
		promptGuidelines: [
			"Use execution_progress only for 4-8 high-level milestones after the implementation document is approved.",
			"Treat the implementation document as the source of truth; update execution_progress only at milestone boundaries.",
			"Do not mark a milestone complete when its required tests or evidence are still failing or missing.",
		],
		parameters: ProgressParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as ProgressAction;
			if (action === "show") {
				if (state.phases.length === 0) return errorResult(action, "no execution plan has been created");
				await ensureOverlay(ctx);
				showOverlay();
				return { content: [{ type: "text", text: "Execution progress shown" }], details: { action, state: cloneState(state) } };
			}

			if (action === "set_plan") {
				if (!params.phases || params.phases.length === 0) return errorResult(action, "phases required for set_plan");
				if (params.phases.length > MAX_PHASES) return errorResult(action, `at most ${MAX_PHASES} phases are supported`);
				state = {
					...(params.title?.trim() ? { title: params.title.trim() } : {}),
					...(params.sourceDoc?.trim() ? { sourceDoc: params.sourceDoc.trim() } : {}),
					phases: params.phases.map((title: string, index: number) => ({ id: index + 1, title: title.trim(), status: "pending" })),
				};
				activity = "ready";
				await ensureOverlay(ctx);
				refresh(ctx);
				return {
					content: [{ type: "text", text: `Created execution progress with ${state.phases.length} phases` }],
					details: { action, state: cloneState(state) },
				};
			}

			if (action === "clear") {
				state = cloneState(EMPTY_STATE);
				activity = "ready";
				updateStatus(ctx);
				releaseOverlay();
				return { content: [{ type: "text", text: "Cleared execution progress" }], details: { action, state: cloneState(state) } };
			}

			if (params.phase === undefined) return errorResult(action, "phase required");
			const phase = state.phases.find((candidate) => candidate.id === params.phase);
			if (!phase) return errorResult(action, `phase #${params.phase} not found`);

			if (action === "start" || action === "resume") {
				for (const candidate of state.phases) {
					if (candidate.status === "active") candidate.status = "pending";
				}
				phase.status = "active";
				delete phase.reason;
				activity = "thinking";
			} else if (action === "complete") {
				phase.status = "done";
				delete phase.reason;
				activity = "ready";
			} else if (action === "block") {
				phase.status = "blocked";
				phase.reason = params.reason?.trim() || "blocked";
				activity = `blocked: ${phase.reason}`;
			} else {
				return errorResult(action, `unsupported action: ${action}`);
			}

			if (action === "complete" && state.phases.length > 0 && state.phases.every((candidate) => candidate.status === "done")) {
				releaseOverlay();
			}
			refresh(ctx);
			return {
				content: [{ type: "text", text: `${action} phase #${phase.id}: ${phase.title}` }],
				details: { action, state: cloneState(state) },
			};
		},

		renderCall(args, theme) {
			const params = args as ProgressParams;
			return new Text(theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", params.action), 0, 0);
		},
	});

	pi.registerCommand("progress", {
		description: "Show or hide the fixed execution progress panel",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "hide") {
				hideOverlay();
				return;
			}
			if (command === "clear") {
				state = cloneState(EMPTY_STATE);
				activity = "ready";
				persistManualState();
				updateStatus(ctx);
				releaseOverlay();
				return;
			}

			if (state.phases.length === 0) return;
			await ensureOverlay(ctx);
			showOverlay();
		},
	});

	pi.registerShortcut(SHOW_SHORTCUT, {
		description: "Show or hide the fixed execution progress panel",
		handler: async (ctx) => {
			if (overlayVisible) {
				hideOverlay();
				return;
			}
			if (state.phases.length === 0) return;
			await ensureOverlay(ctx);
			showOverlay();
		},
	});

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
	pi.on("session_compact", async (_event, ctx) => {
		state = stateFromBranch(ctx);
		pendingResync = hasOpenPlan(state);
		refresh(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const messages: string[] = [];

		if (pendingResync && hasOpenPlan(state)) {
			pendingResync = false;
			const summary = progressSummary(state, activity);
			const remaining = state.phases.filter((phase) => phase.status !== "done").map((phase) => `${phase.id}. ${phase.title}`).join("\n");
			const current = summary.current
				? `${summary.stage}/${summary.total} ${summary.current.title}`
				: `${summary.completed}/${summary.total} ${summary.label}`;
			messages.push(`[CURRENT EXECUTION PROGRESS]\nCurrent: ${current}\nRemaining:\n${remaining || "none"}`);
		}

		if (isImplementationTask(event.prompt) && !hasOpenPlan(state)) {
			messages.push(
				"[EXECUTION PROGRESS POLICY]\n"
				+ "This is a multi-step implementation, repair, or verification task. Before modifying files, automatically derive 4-8 concise milestones from the approved implementation document or current task scope and call execution_progress with set_plan. Do not ask the user to invoke the tool. Start the current milestone with start, and update start/complete/block/resume at milestone boundaries. Never mark a milestone complete while its required tests or evidence are missing or failing. The progress panel is a governance view, not a substitute for test evidence.",
			);
		}

		if (messages.length === 0) return;
		return {
			message: {
				customType: "execution-progress-context",
				content: messages.join("\n\n"),
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === TOOL_NAME || !isMutatingToolCall(event.toolName, event.input)) return;
		await createAutomaticFallbackPlan(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		activity = "thinking";
		refresh(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		activity = "thinking";
		refresh(ctx);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName === TOOL_NAME) return;
		activity = `running: ${event.toolName}`;
		refresh(ctx);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === TOOL_NAME) return;
		activity = event.isError ? `error: ${event.toolName}` : "thinking";
		refresh(ctx);
	});
	pi.on("ui_prompt_start", async (event, ctx) => {
		if (event.kind === "custom") return;
		activity = "waiting for input";
		refresh(ctx);
	});
	pi.on("ui_prompt_end", async (event, ctx) => {
		if (event.kind === "custom") return;
		activity = "thinking";
		refresh(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		activity = "ready";
		refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinner();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		closeOverlay?.();
		closeOverlay = undefined;
		overlayHandle = undefined;
		overlayVisible = false;
		responsiveVisible = false;
		overlayClosing = false;
		overlay = undefined;
		activeTui = undefined;
	});
}

