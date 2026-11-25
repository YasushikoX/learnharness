import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { boundedSmokeOperation, stopOwnedSmokeServer } from "../lib/owned-smoke-lifetime.mjs";
import { captureScreens } from "./screens.mjs";
import { ids, themes } from "./scenario.mjs";

const root = resolve(import.meta.dirname, "../..");
const next = join(root, "node_modules/next/dist/bin/next");
const host = "127.0.0.1";
const usage = "Usage: node scripts/ui-shots/run.mjs --out <dir> [--port 3210] [--themes dark,light] [--build|--no-build]";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const signal = new AbortController();
const interrupt = () => signal.abort(new Error("Screenshot run interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

function start(command, args, env) {
	signal.signal.throwIfAborted();
	const child = spawn(command, args, { cwd: root, env, stdio: "inherit", detached: true });
	const done = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, name) => resolve({ code, name }));
	});
	// The server may exit while the browser is operating.
	void done.catch(() => {});
	return { child, done };
}

async function run(command, args, env) {
	const { child, done } = start(command, args, env);
	let stopping;
	const stop = () => {
		if (!child.pid) return;
		stopping = stopOwnedSmokeServer(child);
		void stopping.catch(() => {});
	};
	signal.signal.addEventListener("abort", stop, { once: true });
	try {
		const { code, name } = await done;
		if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${name ?? code}`);
	} finally {
		signal.signal.removeEventListener("abort", stop);
		await stopping;
	}
}

function appEnv(profile) {
	// Forward build/toolchain settings but leave ambient provider credentials and
	// desktop gate configuration out of the spawned application.
	const keys = ["PATH", "HOME", "TMPDIR", "SHELL", "USER", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"];
	return {
		...Object.fromEntries(keys.map(key => [key, process.env[key]])),
		TZ: "UTC",
		LH_DATA_DIR: join(profile, "data"),
		LH_AUTH_FILE: join(profile, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1",
		LH_UPSTREAM_CHECK: "0",
		NEXT_TELEMETRY_DISABLED: "1",
	};
}

async function checkPort(port) {
	const probe = createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, host, resolve);
	}).catch(error => { throw new Error(`Cannot bind screenshot server to ${host}:${port}: ${error.message}`); });
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function waitForServer(process, origin) {
	const deadline = performance.now() + 60_000;
	for (;;) {
		signal.signal.throwIfAborted();
		if (process.child.exitCode !== null || process.child.signalCode || !process.child.pid) {
			const result = await process.done;
			throw new Error(`Next server exited with ${result.name ?? result.code}`);
		}
		try {
			const response = await fetch(`${origin}/api/chats`, { signal: AbortSignal.timeout(2_000) });
			await response.body?.cancel();
			if (!response.ok) throw new Error(`Next readiness endpoint returned HTTP ${response.status}`);
			return;
		} catch (error) {
			if (error.name !== "TimeoutError" && error.cause?.code !== "ECONNREFUSED") throw error;
		}
		if (performance.now() >= deadline) throw new Error(`Next did not start at ${origin} within 60 seconds`);
		await delay(250, undefined, { signal: signal.signal });
	}
}

async function atLessonComposer(profile, visit) {
	// The app replaces its composer while a question is pending. Load the
	// previous turn of the same transcript without answering or sending a turn.
	const chat = join(profile, "data", "chats", `${ids.lesson}.json`);
	const pending = `${chat}.pending`;
	const earlier = join(profile, "lesson-before-question.json");
	await rename(chat, pending);
	try {
		await rename(earlier, chat);
		await visit();
	} finally {
		await rename(pending, chat);
	}
}

async function captureTheme({ browser, profile, origin, port, theme, stage }) {
	const server = start(process.execPath, [next, "start", "--hostname", host, "--port", String(port)], appEnv(profile));
	let context;
	try {
		await waitForServer(server, origin);
		context = await browser.createBrowserContext();
		return await captureScreens({
			page: await context.newPage(), origin, theme, stage, signal: signal.signal,
			withLessonComposer: visit => atLessonComposer(profile, visit),
		});
	} finally {
		try {
			if (context) await boundedSmokeOperation(() => context.close(), 5_000, undefined);
		} finally {
			if (server.child.pid) await stopOwnedSmokeServer(server.child);
		}
	}
}

async function main() {
	const { values } = parseArgs({
		allowNegative: true,
		options: {
			out: { type: "string" }, port: { type: "string", default: "3210" },
			themes: { type: "string", default: "dark,light" }, build: { type: "boolean", default: true }, help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) { console.log(usage); return; }
	if (!values.out) throw new Error(usage);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${values.port}`);
	const selection = values.themes.split(",");
	if (new Set(selection).size !== selection.length || selection.some(theme => !Object.hasOwn(themes, theme))) {
		throw new Error("--themes must be dark, light, or dark,light");
	}
	await access(chrome);
	await checkPort(port);

	const started = performance.now();
	const out = resolve(values.out);
	await mkdir(out, { recursive: true });
	const scratch = await mkdtemp(join(tmpdir(), "lh-ui-shots-"));
	let stage;
	let browser;
	const closeBrowser = () => { void browser?.close().catch(() => {}); };
	signal.signal.addEventListener("abort", closeBrowser, { once: true });
	try {
		stage = await mkdtemp(join(out, ".ui-shots-"));
		const date = new Date().toISOString().slice(0, 10);
		for (const theme of selection) {
			await run(process.execPath, ["--import", "tsx", "scripts/ui-shots/fixture.ts", scratch, theme, date], appEnv(join(scratch, theme)));
		}
		if (values.build) await run("npm", ["run", "build"], appEnv(join(scratch, selection[0])));
		else await access(join(root, ".next", "BUILD_ID"));
		browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--disable-background-networking"] });
		const origin = `http://${host}:${port}`;
		const entries = [];
		for (const theme of selection) {
			entries.push(...await captureTheme({ browser, profile: join(scratch, theme), origin, port, theme, stage }));
		}
		entries.sort((a, b) => a.file.localeCompare(b.file));
		await writeFile(join(stage, "index.md"), entries.map(({ file, description }) => `- ${file} — ${description}`).join("\n") + "\n");
		const oldIndex = await readFile(join(out, "index.md"), "utf8").catch(error => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		const newFiles = new Set(entries.map(entry => entry.file));
		for (const { file } of entries) await rename(join(stage, file), join(out, file));
		for (const [, file] of oldIndex.matchAll(/^- (\d{2}-[a-z0-9-]+-(?:dark|light)\.png) — /gm)) {
			if (!newFiles.has(file)) await rm(join(out, file), { force: true });
		}
		await rename(join(stage, "index.md"), join(out, "index.md"));
		console.log(`Wrote ${entries.length} screenshots in ${((performance.now() - started) / 1000).toFixed(1)}s to ${out}`);
	} finally {
		signal.signal.removeEventListener("abort", closeBrowser);
		if (browser) {
			const closed = await boundedSmokeOperation(() => browser.close().then(() => true), 5_000, false);
			if (!closed) browser.process()?.kill("SIGKILL");
		}
		await rm(scratch, { recursive: true, force: true });
		if (stage) await rm(stage, { recursive: true, force: true });
	}
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
}
