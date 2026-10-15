import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Use Pi's installed loader and host-provided peers, just as the extension does.
// Set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent directory
// when it is not resolvable from this checkout. No model or Pi session is started.
const packageDir = process.env.PI_PACKAGE_DIR ?? dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/package.json")));
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const aliases = Object.fromEntries([
	"@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
].map((name) => [name, fileURLToPath(import.meta.resolve(name, pathToFileURL(join(packageDir, "dist/index.js")).href))]));
const jiti = createJiti(import.meta.url, { alias: aliases, fsCache: false });
const { default: backgroundTasks } = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const stateType = "pi-background-tasks-state";
const user = process.getuid?.() ?? process.env.USER ?? process.env.LOGNAME ?? "unknown";
const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);

async function waitFor(predicate) {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "timed out waiting for test subprocess");
		await delay(10);
	}
}

function fixture(t, { ephemeral = false, seedState, missingCwd = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-background-isolation-test-"));
	const entries = seedState ? [{ type: "custom", customType: stateType, data: seedState }] : [];
	const hooks = new Map();
	const tools = new Map();
	const events = [];
	const pending = [];
	const sessionFile = ephemeral ? undefined : join(root, "session.jsonl");
	const gate = join(root, "release");
	const ctx = { cwd: missingCwd ? join(root, "nonexistent") : root, mode: "print", sessionManager: { getSessionFile: () => sessionFile, getEntries: () => entries } };
	const pi = {
		on: (name, handler) => hooks.set(name, handler),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		events: { emit: (name, data) => events.push({ name, data }) },
		sendMessage: () => {},
	};
	backgroundTasks(pi);
	hooks.get("session_start")({}, ctx);
	const state = () => entries.findLast((e) => e.customType === stateType)?.data;
	const invoke = (params) => {
		const promise = tools.get("bash").execute("test-call", { notify_on_exit: false, ...params }, new AbortController().signal, undefined, ctx);
		pending.push(promise);
		return promise;
	};
	const command = (marker, code = 0) => {
		const script = `console.log(${JSON.stringify(marker)}); const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(${code}); }, 10); setTimeout(() => process.exit(124), 5000);`;
		return `${quote(process.execPath)} -e ${quote(script)}`;
	};
	const release = () => writeFileSync(gate, "");
	const sessionRoot = () => {
		const token = state()?.sessionToken ?? createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
		return join(tmpdir(), `pi-background-tasks-${user}`, token);
	};
	t.after(async () => {
		release();
		const timeout = new AbortController();
		try {
			await Promise.race([
				Promise.allSettled(pending),
				delay(7_000, undefined, { signal: timeout.signal }).then(() => { throw new Error("test invocation teardown timed out"); }),
			]);
		} finally {
			timeout.abort();
		}
		await waitFor(() => {
			const latest = state();
			return !latest || latest.jobs.length === 0;
		});
		hooks.get("session_shutdown")({ reason: "reload" }, ctx);
		rmSync(sessionRoot(), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	return { invoke, command, release, state, events, sessionRoot };
}

function output(result) {
	return result.content.map((block) => block.text).join("\n");
}

function assertOwnOutput(result, marker) {
	const lines = output(result).split("\n");
	assert.equal(lines.length, 2, "one header and only this invocation's marker");
	assert.match(lines[0], /^=== started .* ===$/);
	assert.equal(lines[1], marker);
}

test("concurrent foreground calls return only their own output and clean their directories", async (t) => {
	const f = fixture(t);
	const markers = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"];
	const pending = markers.map((marker) => f.invoke({ command: f.command(marker) }));
	const paths = readdirSync(f.sessionRoot());
	assert.equal(paths.length, markers.length);
	assert.equal(new Set(paths).size, markers.length);
	for (const path of paths) {
		assert.match(path, /^invocation-/);
		assert.equal(statSync(join(f.sessionRoot(), path)).mode & 0o777, 0o700);
		assert.equal(statSync(join(f.sessionRoot(), path, "output.log")).mode & 0o777, 0o600);
		assert.equal(statSync(join(f.sessionRoot(), path, "exit.status")).mode & 0o777, 0o600);
	}
	f.release();
	const results = await Promise.all(pending);
	results.forEach((result, i) => assertOwnOutput(result, markers[i]));
	assert.deepEqual(readdirSync(f.sessionRoot()), []);
});

test("a foreground failure does not contaminate another call or leave storage behind", async (t) => {
	const f = fixture(t);
	const failed = f.invoke({ command: f.command("EXPECTED_FAILURE", 7) });
	const checkFailure = assert.rejects(failed, (error) => {
		assert.match(error.message, /EXPECTED_FAILURE/);
		assert.match(error.message, /Command exited with code 7/);
		assert.doesNotMatch(error.message, /SUCCESS_MARKER/);
		return true;
	});
	const succeeded = f.invoke({ command: f.command("SUCCESS_MARKER") });
	f.release();
	await checkFailure;
	assertOwnOutput(await succeeded, "SUCCESS_MARKER");
	assert.deepEqual(readdirSync(f.sessionRoot()), []);
});

test("foreground cleanup cannot delete immediate or promoted background logs", async (t) => {
	const f = fixture(t);
	const foreground = f.invoke({ command: f.command("FOREGROUND") });
	const immediate = await f.invoke({ command: f.command("IMMEDIATE"), run_in_background: true });
	const promoted = await f.invoke({ command: f.command("PROMOTED"), background_after_seconds: 0 });
	assert.match(output(immediate), /Started job-1/);
	assert.match(output(promoted), /Moved job-2/);
	const jobs = f.state().jobs;
	assert.equal(jobs.length, 2);
	assert.notEqual(jobs[0].logPath, jobs[1].logPath);
	assert.equal(readdirSync(f.sessionRoot()).length, 3);
	f.release();
	assertOwnOutput(await foreground, "FOREGROUND");
	await waitFor(() => f.state().jobs.length === 0);
	for (const [i, marker] of ["IMMEDIATE", "PROMOTED"].entries()) {
		const text = readFileSync(jobs[i].logPath, "utf8");
		assert.match(text, new RegExp(`\\n${marker}\\n$`));
		assert.doesNotMatch(text, /FOREGROUND/);
		assert.equal(readFileSync(jobs[i].statusPath, "utf8").trim(), "0");
	}
	assert.equal(readdirSync(f.sessionRoot()).length, 2);
});

test("distinct file-backed sessions use distinct session directories", async (t) => {
	const first = fixture(t);
	const second = fixture(t);
	await first.invoke({ command: first.command("FIRST"), run_in_background: true });
	await second.invoke({ command: second.command("SECOND"), run_in_background: true });
	assert.match(first.state().sessionToken, /^[a-f0-9]{12}$/);
	assert.notEqual(first.sessionRoot(), second.sessionRoot());
	first.release();
	second.release();
});

test("ephemeral sessions in the same process get distinct tokens", async (t) => {
	const first = fixture(t, { ephemeral: true });
	const second = fixture(t, { ephemeral: true });
	await first.invoke({ command: first.command("FIRST"), run_in_background: true });
	await second.invoke({ command: second.command("SECOND"), run_in_background: true });
	assert.match(first.state().sessionToken, /^[a-f0-9]{12}$/);
	assert.notEqual(first.state().sessionToken, second.state().sessionToken);
	first.release();
	second.release();
});

test("restoration preserves a persisted session token, including ephemeral sessions", async (t) => {
	const token = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12);
	const seedState = { version: 1, nextJobNumber: 9, sessionToken: token, jobs: [] };
	const f = fixture(t, { ephemeral: true, seedState });
	const result = await f.invoke({ command: f.command("RESTORED"), run_in_background: true });
	assert.match(output(result), /Started job-10/);
	assert.equal(f.state().sessionToken, seedState.sessionToken);
	assert.equal(dirname(dirname(f.state().jobs[0].logPath)), f.sessionRoot());
	f.release();
});

test("restoration monitors an active legacy job using its original flat paths", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-background-legacy-test-"));
	const gate = join(root, "release");
	const token = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12);
	const logDirectory = join(tmpdir(), `pi-background-tasks-${user}`, token);
	mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
	const logPath = join(logDirectory, "job-4.log");
	const statusPath = join(logDirectory, "job-4.status");
	writeFileSync(logPath, "legacy marker\n", { mode: 0o600 });
	writeFileSync(statusPath, "", { mode: 0o600 });
	const script = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { fs.writeFileSync(${JSON.stringify(statusPath)}, '0\\n'); process.exit(0); } }, 10); setTimeout(() => process.exit(124), 5000);`;
	const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
	const exited = new Promise((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
	// Release even after assertion failures, before fixture cleanup waits for jobs.
	t.after(async () => {
		writeFileSync(gate, "");
		await exited;
		rmSync(root, { recursive: true, force: true });
	});
	const legacyJob = {
		id: "job-4", description: "restored legacy job", command: "legacy command",
		cwd: root, pid: child.pid, pgid: child.pid, logPath, statusPath,
		createdAt: Date.now(), notifyOnExit: false, status: "running",
	};
	const f = fixture(t, { seedState: { version: 1, nextJobNumber: 4, sessionToken: token, jobs: [legacyJob] } });
	const started = f.events.find((event) => event.name === "background-tasks:started");
	assert.equal(started?.data.logPath, logPath);
	writeFileSync(gate, "");
	assert.equal(await exited, 0);
	await waitFor(() => f.state()?.jobs.length === 0);
	const finished = f.events.find((event) => event.name === "background-tasks:finished");
	assert.equal(finished?.data.logPath, logPath);
	assert.equal(finished?.data.status, "completed");
	assert.equal(finished?.data.exitCode, 0);
	assert.equal(readFileSync(logPath, "utf8"), "legacy marker\n");
});

test("launch failure is caught without crashing the host or leaking invocation files", async (t) => {
	if (process.env.PI_BACKGROUND_LAUNCH_PROBE === "1") {
		const f = fixture(t, { missingCwd: true });
		await assert.rejects(f.invoke({ command: "printf 'must not execute\\n'" }), /could not start background process/);
		// Flush the asynchronous spawn error: a missing listener would crash here.
		await delay(10);
		assert.deepEqual(readdirSync(f.sessionRoot()), []);
		return;
	}
	// Keep a possible unhandled ChildProcess error out of the parent test runner.
	const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
	const { stdout, stderr } = await promisify(execFile)(process.execPath, [
		"--experimental-import-meta-resolve", "--test", "--test-name-pattern=^launch failure",
		fileURLToPath(import.meta.url),
	], { env: { ...env, PI_BACKGROUND_LAUNCH_PROBE: "1" }, timeout: 15_000 });
	assert.match(stdout, /# pass 1/);
	assert.equal(stderr, "");
});
