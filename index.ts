/**
 * Minimal, portable background process management for Pi.
 *
 * This extension intentionally owns only local processes, their logs, state,
 * deadlines, and notifications. Integrations such as tmux subscribe to its
 * lifecycle events rather than becoming process managers themselves.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatLocalTimestamp } from "./local-time.ts";
import { Type } from "typebox";
import { parse } from "yaml";

const STATE_ENTRY = "pi-background-tasks-state";
const EVENT_STARTED = "background-tasks:started";
const EVENT_FINISHED = "background-tasks:finished";
const STATE_VERSION = 1;
const COMPLETION_TAIL_CHARS = 500;
const POLL_INTERVAL_MS = 1_000;
const KILL_GRACE_MS = 5_000;

const configPath = fileURLToPath(new URL("./config.yaml", import.meta.url));

type JobStatus = "running" | "completed" | "failed" | "killed" | "timed_out";
type RequestedTerminalStatus = "killed" | "timed_out";

type Job = {
	id: string;
	description: string;
	command: string;
	cwd: string;
	pid: number;
	pgid: number;
	logPath: string;
	statusPath: string;
	createdAt: number;
	maxRunSeconds?: number;
	notifyOnExit: boolean;
	status: JobStatus;
	requestedTerminalStatus?: RequestedTerminalStatus;
	exitCode?: number | null;
	endedAt?: number;
};

type RuntimeJob = Job & {
	child?: ChildProcess;
	deadlineTimer?: NodeJS.Timeout;
	killTimer?: NodeJS.Timeout;
};

type PersistedState = {
	version: number;
	nextJobNumber: number;
	sessionToken: string;
	jobs: Job[];
	finishedJobIds?: string[];
};

type BackgroundConfig = {
	backgroundAfterSeconds: number;
};

type ProcessExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

type ProcessHandle = {
	child: ChildProcess;
	pid: number;
	pgid: number;
	logPath: string;
	statusPath: string;
	createdAt: number;
	exit: Promise<ProcessExit>;
};

type Runtime = {
	config: BackgroundConfig;
	nextJobNumber: number;
	sessionToken: string;
	jobs: Map<string, RuntimeJob>;
	finishedJobIds: Set<string>;
	onChange?: () => void;
	pollTimer?: NodeJS.Timeout;
};

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function readConfig(): BackgroundConfig {
	let parsed: unknown;
	try {
		parsed = parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`could not read background-tasks configuration ${configPath}: ${(error as Error).message}`);
	}
	const value = (parsed as { background_after_seconds?: unknown } | null)?.background_after_seconds;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${configPath}: background_after_seconds must be a finite number greater than or equal to zero`);
	}
	return { backgroundAfterSeconds: value };
}

function sessionToken(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile() ?? `ephemeral-${process.pid}`;
	return createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
}

function logRoot(token: string): string {
	// Keep temporary logs isolated between users on shared hosts. Do not rely on
	// $USER: the process UID is stable even when the environment is incomplete or
	// inherited from another launcher.
	const user = process.getuid?.() ?? process.env.USER ?? process.env.LOGNAME ?? "unknown";
	return join(tmpdir(), `pi-background-tasks-${user}`, token);
}

function compactDescription(command: string): string {
	const compact = command.replaceAll(/\s+/g, " ").trim();
	return compact.length <= 120 ? compact : `${compact.slice(0, 117)}…`;
}

function requirePositiveSeconds(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number of seconds`);
	return value;
}

function requireNonNegativeSeconds(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number of seconds greater than or equal to zero`);
	return value;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainder = seconds % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(remainder).padStart(2, "0")}s`;
	return `${remainder}s`;
}

function readTail(path: string, maxChars = COMPLETION_TAIL_CHARS): string {
	try {
		const size = statSync(path).size;
		const length = Math.min(size, maxChars);
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		const content = buffer.toString("utf8").trimEnd();
		return size > length ? `…${content}` : content;
	} catch {
		return "";
	}
}

function processGroupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processExitCode(statusPath: string): number | null {
	try {
		const value = readFileSync(statusPath, "utf8").trim();
		if (!/^-?\d+$/.test(value)) return null;
		return Number(value);
	} catch {
		return null;
	}
}

function emitStarted(pi: ExtensionAPI, job: RuntimeJob): void {
	pi.events.emit(EVENT_STARTED, {
		id: job.id,
		description: job.description,
		logPath: job.logPath,
		pid: job.pid,
		pgid: job.pgid,
	});
}

function emitFinished(pi: ExtensionAPI, job: RuntimeJob): void {
	pi.events.emit(EVENT_FINISHED, {
		id: job.id,
		description: job.description,
		logPath: job.logPath,
		status: job.status,
		exitCode: job.exitCode,
	});
}

function updateJobFooter(ctx: ExtensionContext, runtime: Runtime): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const footerSession = {
			get state() {
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			},
			sessionManager: ctx.sessionManager,
			getContextUsage: () => ctx.getContextUsage(),
			modelRuntime: { isUsingSubscription: () => false },
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
		const footer = new FooterComponent(footerSession, footerData);
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: () => {
				unsubscribe();
				footer.dispose();
			},
			invalidate: () => footer.invalidate(),
			render(width: number): string[] {
				const lines = footer.render(width);
				if (lines.length === 0) return lines;

				const pathLine = lines[0] ?? "";
				const jobLine = theme.fg("dim", `Background jobs: ${runtime.jobs.size} running`);
				const jobWidth = visibleWidth(jobLine);
				const pathWidth = visibleWidth(pathLine);
				if (jobWidth >= width) {
					lines[0] = truncateToWidth(jobLine, width, "");
				} else {
					const gap = Math.max(2, width - pathWidth - jobWidth);
					const availablePathWidth = width - jobWidth - 1;
					const renderedPath = pathWidth + gap + jobWidth <= width
						? pathLine
						: truncateToWidth(pathLine, availablePathWidth, "");
					const renderedGap = Math.max(1, width - visibleWidth(renderedPath) - jobWidth);
					lines[0] = `${renderedPath}${" ".repeat(renderedGap)}${jobLine}`;
				}
				return lines;
			},
		};
	});
}

function serialise(runtime: Runtime): PersistedState {
	return {
		version: STATE_VERSION,
		nextJobNumber: runtime.nextJobNumber,
		sessionToken: runtime.sessionToken,
		jobs: [...runtime.jobs.values()].map(({ child: _child, deadlineTimer: _deadline, killTimer: _kill, ...job }) => job),
		finishedJobIds: [...runtime.finishedJobIds],
	};
}

function persist(pi: ExtensionAPI, runtime: Runtime): void {
	pi.appendEntry(STATE_ENTRY, serialise(runtime));
}

function latestState(ctx: ExtensionContext): PersistedState | undefined {
	const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>;
	const state = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)?.data;
	if (!state || typeof state !== "object") return undefined;
	const candidate = state as Partial<PersistedState>;
	if (candidate.version !== STATE_VERSION || !Array.isArray(candidate.jobs) || typeof candidate.nextJobNumber !== "number" || typeof candidate.sessionToken !== "string") {
		return undefined;
	}
	return candidate as PersistedState;
}

function clearJobTimers(job: RuntimeJob): void {
	if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
	if (job.killTimer) clearTimeout(job.killTimer);
	job.deadlineTimer = undefined;
	job.killTimer = undefined;
}

function terminateGroup(job: RuntimeJob, signal: NodeJS.Signals): void {
	try {
		process.kill(-job.pgid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function requestTermination(pi: ExtensionAPI, runtime: Runtime, job: RuntimeJob, reason: RequestedTerminalStatus): void {
	if (job.status !== "running") return;
	job.requestedTerminalStatus = reason;
	terminateGroup(job, "SIGTERM");
	if (!job.killTimer) {
		job.killTimer = setTimeout(() => {
			if (job.status === "running" && processGroupExists(job.pgid)) terminateGroup(job, "SIGKILL");
		}, KILL_GRACE_MS);
		job.killTimer.unref();
	}
	persist(pi, runtime);
}

function notifyFinished(pi: ExtensionAPI, job: RuntimeJob): void {
	if (!job.notifyOnExit) return;
	const duration = formatDuration((job.endedAt ?? Date.now()) - job.createdAt);
	const exit = job.exitCode === undefined || job.exitCode === null ? "unknown" : String(job.exitCode);
	const tail = readTail(job.logPath);
	const tailText = tail ? `\nLog tail:\n${tail}` : "";
	pi.sendMessage(
		{
			customType: "background-tasks:finished",
			content: `[BACKGROUND] ${job.description} (${job.id}) ${job.status}; exit=${exit}; duration=${duration}; log: ${job.logPath}${tailText}`,
			display: true,
			details: { jobId: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function finishJob(pi: ExtensionAPI, runtime: Runtime, job: RuntimeJob, exit: ProcessExit): void {
	if (job.status !== "running") return;
	job.exitCode = exit.code ?? processExitCode(job.statusPath);
	job.status = job.requestedTerminalStatus === "killed"
		? "killed"
		: job.requestedTerminalStatus === "timed_out"
			? "timed_out"
			: job.exitCode === 0 ? "completed" : "failed";
	job.endedAt = Date.now();
	clearJobTimers(job);
	runtime.jobs.delete(job.id);
	runtime.finishedJobIds.add(job.id);
	while (runtime.finishedJobIds.size > 4_096) {
		const oldest = runtime.finishedJobIds.values().next().value as string | undefined;
		if (oldest === undefined) break;
		runtime.finishedJobIds.delete(oldest);
	}
	persist(pi, runtime);
	runtime.onChange?.();
	emitFinished(pi, job);
	notifyFinished(pi, job);
}

function scheduleDeadline(pi: ExtensionAPI, runtime: Runtime, job: RuntimeJob): void {
	if (job.maxRunSeconds === undefined || job.status !== "running") return;
	const remaining = job.maxRunSeconds * 1_000 - (Date.now() - job.createdAt);
	if (remaining <= 0) {
		requestTermination(pi, runtime, job, "timed_out");
		return;
	}
	job.deadlineTimer = setTimeout(() => requestTermination(pi, runtime, job, "timed_out"), remaining);
	job.deadlineTimer.unref();
}

function watchBackgroundProcess(pi: ExtensionAPI, runtime: Runtime, job: RuntimeJob, exit: Promise<ProcessExit>): void {
	// A shell command may leave descendants in its process group. Do not report
	// completion until that whole group is gone; the poller handles that case.
	exit.then((result) => {
		if (!processGroupExists(job.pgid)) finishJob(pi, runtime, job, result);
	});
	scheduleDeadline(pi, runtime, job);
	emitStarted(pi, job);
}

function createProcess(command: string, cwd: string, logPath: string, statusPath: string): ProcessHandle {
	const createdAt = Date.now();
	mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
	writeFileSync(logPath, `=== started ${formatLocalTimestamp(createdAt)} ===\n`, { flag: "a", mode: 0o600 });
	writeFileSync(statusPath, "", { flag: "w", mode: 0o600 });
	const logFd = openSync(logPath, "a", 0o600);
	const script = [
		"set +e",
		"(",
		command,
		")",
		"code=$?",
		`printf '%s\\n' \"$code\" > ${shellQuote(statusPath)}`,
		"exit \"$code\"",
	].join("\n");
	const child = spawn("/bin/bash", ["-lc", script], {
		cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	closeSync(logFd);
	if (!child.pid) throw new Error("could not start background process");
	const exit = new Promise<ProcessExit>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", () => resolve({ code: null, signal: null }));
	});
	return { child, pid: child.pid, pgid: child.pid, logPath, statusPath, createdAt, exit };
}

function newJob(runtime: Runtime, params: {
	command: string;
	description?: string;
	cwd: string;
	maxRunSeconds?: number;
	notifyOnExit: boolean;
	process: ProcessHandle;
}): RuntimeJob {
	const id = `job-${++runtime.nextJobNumber}`;
	return {
		id,
		description: params.description?.trim() || compactDescription(params.command),
		command: params.command,
		cwd: params.cwd,
		pid: params.process.pid,
		pgid: params.process.pgid,
		logPath: params.process.logPath,
		statusPath: params.process.statusPath,
		createdAt: params.process.createdAt,
		maxRunSeconds: params.maxRunSeconds,
		notifyOnExit: params.notifyOnExit,
		status: "running",
		child: params.process.child,
	};
}

function jobPaths(runtime: Runtime, number: number): { logPath: string; statusPath: string } {
	const root = logRoot(runtime.sessionToken);
	const stem = `job-${number}`;
	return { logPath: join(root, `${stem}.log`), statusPath: join(root, `${stem}.status`) };
}

function renderJobs(runtime: Runtime): string {
	const jobs = [...runtime.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
	if (jobs.length === 0) return "No managed background jobs are running.";
	const now = Date.now();
	return ["Managed background jobs:", ...jobs.map((job) => {
		const elapsed = formatDuration(now - job.createdAt);
		const limit = job.maxRunSeconds === undefined ? "unlimited" : formatDuration(job.maxRunSeconds * 1_000);
		const remaining = job.maxRunSeconds === undefined ? "unlimited" : formatDuration(Math.max(0, job.maxRunSeconds * 1_000 - (now - job.createdAt)));
		return [
			`${job.id}  running  ${job.description}`,
			`  elapsed=${elapsed} max_run=${limit} remaining=${remaining} pid=${job.pid} pgid=${job.pgid}`,
			`  log=${job.logPath}`,
		].join("\n");
	})].join("\n");
}

function startPoller(pi: ExtensionAPI, runtime: Runtime): void {
	if (runtime.pollTimer) return;
	runtime.pollTimer = setInterval(() => {
		for (const job of [...runtime.jobs.values()]) {
			if (!processGroupExists(job.pgid)) {
				const exitCode = processExitCode(job.statusPath);
				finishJob(pi, runtime, job, { code: exitCode, signal: null });
			}
		}
	}, POLL_INTERVAL_MS);
	runtime.pollTimer.unref();
}

function restore(pi: ExtensionAPI, ctx: ExtensionContext, config: BackgroundConfig): Runtime {
	const saved = latestState(ctx);
	const runtime: Runtime = {
		config,
		nextJobNumber: saved?.nextJobNumber ?? 0,
		sessionToken: saved?.sessionToken ?? sessionToken(ctx),
		jobs: new Map(),
		finishedJobIds: new Set(saved?.finishedJobIds?.filter((id): id is string => typeof id === "string") ?? []),
	};
	for (const value of saved?.jobs ?? []) {
		if (!value || typeof value !== "object" || value.status !== "running" || typeof value.id !== "string" || typeof value.pgid !== "number") continue;
		const job: RuntimeJob = { ...value };
		runtime.jobs.set(job.id, job);
		if (processGroupExists(job.pgid)) {
			scheduleDeadline(pi, runtime, job);
			emitStarted(pi, job);
		} else {
			finishJob(pi, runtime, job, { code: processExitCode(job.statusPath), signal: null });
		}
	}
	startPoller(pi, runtime);
	return runtime;
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	const config = readConfig();
	let runtime: Runtime | undefined;

	pi.on("session_start", (_event, ctx) => {
		const sessionRuntime = restore(pi, ctx, config);
		runtime = sessionRuntime;
		sessionRuntime.onChange = () => updateJobFooter(ctx, sessionRuntime);
		updateJobFooter(ctx, sessionRuntime);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		if (!runtime) return;
		const sessionRuntime = runtime;
		sessionRuntime.onChange = undefined;
		if (sessionRuntime.pollTimer) clearInterval(sessionRuntime.pollTimer);
		sessionRuntime.pollTimer = undefined;
		if (event.reason === "quit") {
			for (const job of sessionRuntime.jobs.values()) requestTermination(pi, sessionRuntime, job, "killed");
		} else {
			// A reload immediately reconstructs and reschedules these timers in its
			// fresh extension instance. Do not leave callbacks bound to a stale
			// session runtime after any session transition.
			for (const job of sessionRuntime.jobs.values()) clearJobTimers(job);
		}
		persist(pi, sessionRuntime);
	});

	pi.registerCommand("jobs", {
		description: "List managed background jobs",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime ? renderJobs(runtime) : "Background-task state is not initialized.", "info");
		},
	});

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: "Run a bash command. It can start immediately in the background or move there after a configured foreground delay.",
		promptSnippet: "Run shell commands; use run_in_background=true for long work",
		promptGuidelines: [
			"Use bash with run_in_background=true when a command is expected to run for a long time.",
			"Use jobs action='list' to inspect managed background jobs, jobs action='kill' to cancel one, or jobs action='extend' to increase its total time limit.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run." }),
			description: Type.Optional(Type.String({ description: "Optional human-readable label for a background job." })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Start in the background immediately. Default false." })),
			background_after_seconds: Type.Optional(Type.Number({ minimum: 0, description: "Foreground-only delay before moving work to the background. Defaults to config.yaml." })),
			max_run_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Maximum total process lifetime from creation, in seconds." })),
			notify_on_exit: Type.Optional(Type.Boolean({ description: "Notify the agent when the background job exits. Default true." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!runtime) throw new Error("background-task state is not initialized");
			const p = params as {
				command: string;
				description?: string;
				run_in_background?: boolean;
				background_after_seconds?: number;
				max_run_seconds?: number;
				notify_on_exit?: boolean;
			};
			if (!p.command.trim()) throw new Error("command is empty");
			const maxRunSeconds = requirePositiveSeconds(p.max_run_seconds, "max_run_seconds");
			const backgroundAfterSeconds = requireNonNegativeSeconds(p.background_after_seconds, "background_after_seconds") ?? runtime.config.backgroundAfterSeconds;
			const notifyOnExit = p.notify_on_exit !== false;
			const paths = jobPaths(runtime, runtime.nextJobNumber + 1);
			const process = createProcess(p.command, ctx.cwd, paths.logPath, paths.statusPath);

			if (p.run_in_background) {
				const job = newJob(runtime, { command: p.command, description: p.description, cwd: ctx.cwd, maxRunSeconds, notifyOnExit, process });
				runtime.jobs.set(job.id, job);
				persist(pi, runtime);
				runtime.onChange?.();
				watchBackgroundProcess(pi, runtime, job, process.exit);
				return { content: [{ type: "text", text: `Started ${job.id} in the background. Description: ${job.description}; PID/PGID: ${job.pgid}; log: ${job.logPath}` }], details: undefined };
			}

			let promote: (() => void) | undefined;
			const promotion = new Promise<"promote">((resolve) => { promote = () => resolve("promote"); });
			const backgroundTimer = setTimeout(() => promote?.(), backgroundAfterSeconds * 1_000);
			backgroundTimer.unref();
			let maxTimer: NodeJS.Timeout | undefined;
			const deadline = maxRunSeconds === undefined ? undefined : new Promise<"timed_out">((resolve) => {
				maxTimer = setTimeout(() => {
					try { globalThis.process.kill(-process.pgid, "SIGTERM"); } catch { /* process already exited */ }
					resolve("timed_out");
				}, maxRunSeconds * 1_000);
				maxTimer.unref();
			});
			let abortListener: (() => void) | undefined;
			const aborted = new Promise<"aborted">((resolve) => {
				abortListener = () => {
					try { globalThis.process.kill(-process.pgid, "SIGTERM"); } catch { /* process already exited */ }
					resolve("aborted");
				};
				if (signal?.aborted) abortListener();
				else signal?.addEventListener("abort", abortListener, { once: true });
			});
			const outcome = await Promise.race([
				process.exit.then((exit) => ({ kind: "exit" as const, exit })),
				promotion.then(() => ({ kind: "promote" as const })),
				deadline?.then(() => ({ kind: "timed_out" as const })),
				aborted.then(() => ({ kind: "aborted" as const })),
			].filter(Boolean) as Array<Promise<{ kind: "exit"; exit: ProcessExit } | { kind: "promote" } | { kind: "timed_out" } | { kind: "aborted" }>>);
			clearTimeout(backgroundTimer);
			if (maxTimer) clearTimeout(maxTimer);
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);

			if (outcome.kind === "promote") {
				const job = newJob(runtime, { command: p.command, description: p.description, cwd: ctx.cwd, maxRunSeconds, notifyOnExit, process });
				runtime.jobs.set(job.id, job);
				persist(pi, runtime);
				runtime.onChange?.();
				watchBackgroundProcess(pi, runtime, job, process.exit);
				return { content: [{ type: "text", text: `Moved ${job.id} to the background after ${backgroundAfterSeconds}s. Description: ${job.description}; PID/PGID: ${job.pgid}; log: ${job.logPath}` }], details: undefined };
			}

			const exit = outcome.kind === "exit" ? outcome.exit : await process.exit;
			const output = readTail(process.logPath, 50_000) || "(no output)";
			try { rmSync(process.logPath, { force: true }); rmSync(process.statusPath, { force: true }); } catch { /* best-effort foreground cleanup */ }
			if (outcome.kind === "timed_out") throw new Error(`${output}\n\nCommand exceeded max_run_seconds=${maxRunSeconds}.`);
			if (outcome.kind === "aborted") throw new Error(`${output}\n\nCommand aborted.`);
			if (exit.code !== 0) throw new Error(`${output}\n\nCommand exited with code ${exit.code ?? "signal"}.`);
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	});

	pi.registerTool({
		name: "jobs",
		label: "Background Jobs",
		description: "List managed background jobs, cancel one, or extend one job's total time limit.",
		promptSnippet: "jobs(action?, job_id?, max_run_seconds?) — list, kill, or extend local background jobs",
		promptGuidelines: [
			"Use jobs action='list' to inspect active local background jobs; use bash to read a listed log path.",
			"Use jobs action='kill' only for an obsolete, invalid, or wedged local background job.",
		],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["list", "kill", "extend"] as const, { description: "Action to perform. Default list." })),
			job_id: Type.Optional(Type.String({ description: "Managed job ID. Required for kill and extend." })),
			max_run_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "New total lifetime from job creation. Required for extend." })),
		}),
		async execute(_toolCallId, params) {
			if (!runtime) throw new Error("background-task state is not initialized");
			const p = params as { action?: "list" | "kill" | "extend"; job_id?: string; max_run_seconds?: number };
			const action = p.action ?? "list";
			if (action === "list") return { content: [{ type: "text", text: renderJobs(runtime) }], details: undefined };
			if (!p.job_id) throw new Error(`jobs action=${action} requires job_id`);
			const job = runtime.jobs.get(p.job_id);
			if (!job) throw new Error(`managed running job not found: ${p.job_id}`);
			if (action === "kill") {
				requestTermination(pi, runtime, job, "killed");
				return { content: [{ type: "text", text: `Sent SIGTERM to process group ${job.pgid} for ${job.id}.` }], details: undefined };
			}
			const newLimit = requirePositiveSeconds(p.max_run_seconds, "max_run_seconds");
			if (newLimit === undefined) throw new Error("jobs action=extend requires max_run_seconds");
			if (job.maxRunSeconds === undefined) throw new Error(`${job.id} already has an unlimited maximum runtime`);
			if (newLimit <= job.maxRunSeconds) throw new Error(`max_run_seconds must exceed the current limit of ${job.maxRunSeconds}s`);
			job.maxRunSeconds = newLimit;
			if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
			scheduleDeadline(pi, runtime, job);
			persist(pi, runtime);
			return { content: [{ type: "text", text: `Extended ${job.id} to a total max_run_seconds=${newLimit}.` }], details: undefined };
		},
	});
}
