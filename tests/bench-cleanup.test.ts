import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { removeTempDirVerified, stopProcessGroup } from "../scripts/bench-chat-switch.mjs";

describe("bench-chat-switch cleanup and coverage timing", () => {
	it("defect 3 regression: kills the whole server process group before removing temp dir so lingering workers cannot recreate it", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bench-cleanup-test-"));
		const readyFile = path.join(home, "ready");
		const prefDir = path.join(home, "Library", "Preferences", "nextjs-nodejs");

		// Mimics `next dev`: parent spawns a worker child in the same process group.
		// If only the parent is signaled (d4df4e93's bug), the worker survives and recreates
		// <home>/Library/Preferences/nextjs-nodejs after rmSync.
		const workerCode = [
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const dir = process.env.BENCH_PREF_DIR;',
			'fs.writeFileSync(process.env.BENCH_READY_FILE, String(process.pid));',
			'setInterval(() => {',
			'  fs.mkdirSync(dir, { recursive: true });',
			'  fs.writeFileSync(path.join(dir, "config.json"), "{}");',
			'}, 40);',
		].join(" ");
		const parentCode = [
			'const { spawn } = require("node:child_process");',
			'spawn(process.execPath, ["-e", process.env.BENCH_WORKER_CODE], { env: process.env, stdio: "ignore" });',
			'setInterval(() => {}, 1000);',
		].join(" ");

		const child = spawn(process.execPath, ["-e", parentCode], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				BENCH_PREF_DIR: prefDir,
				BENCH_READY_FILE: readyFile,
				BENCH_WORKER_CODE: workerCode,
			},
		});

		try {
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(readyFile) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 25));
			}
			assert.ok(fs.existsSync(readyFile), "worker process should have started");

			await stopProcessGroup(child);
			await removeTempDirVerified(home);
			assert.equal(fs.existsSync(home), false, "temp folder must be gone immediately after removal");

			// Wait longer than the worker's 40ms write interval to confirm no lingering child recreates it.
			await new Promise((r) => setTimeout(r, 250));
			assert.equal(fs.existsSync(home), false, "temp folder must stay gone after process-group shutdown");
		} finally {
			await stopProcessGroup(child).catch(() => {});
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("defect 3 regression: waits for detached Next.js shutdown helpers (_events_<pid>_) before removing temp dir", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bench-flush-test-"));
		const readyFile = path.join(home, "ready");
		const prefDir = path.join(home, "Library", "Preferences", "nextjs-nodejs");

		// Mimics Next.js 16's SIGTERM handler spawning a detached telemetry flush helper in its own PGID
		// whose argv includes _events_<parentPid>_ and writes under <HOME>/Library/Preferences/nextjs-nodejs.
		const helperCode = [
			'const fs = require("node:fs");',
			'setTimeout(() => {',
			'  fs.mkdirSync(process.env.BENCH_PREF_DIR, { recursive: true });',
			'  process.exit(0);',
			'}, 150);',
		].join(" ");
		const parentCode = [
			'const fs = require("node:fs");',
			'const { spawn } = require("node:child_process");',
			'fs.writeFileSync(process.env.BENCH_READY_FILE, String(process.pid));',
			'process.on("SIGTERM", () => {',
			'  const helper = spawn(process.execPath, ["-e", process.env.BENCH_HELPER_CODE, "_events_" + process.pid + "_deadbeef.json"], { detached: true, env: process.env, stdio: "ignore" });',
			'  helper.unref();',
			'  process.exit(0);',
			'});',
			'setInterval(() => {}, 1000);',
		].join(" ");

		const child = spawn(process.execPath, ["-e", parentCode], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				BENCH_PREF_DIR: prefDir,
				BENCH_READY_FILE: readyFile,
				BENCH_HELPER_CODE: helperCode,
			},
		});

		try {
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(readyFile) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 25));
			}
			assert.ok(fs.existsSync(readyFile), "parent process should have started");

			await stopProcessGroup(child);
			await removeTempDirVerified(home);
			assert.equal(fs.existsSync(home), false, "temp folder must be gone immediately after removal");

			await new Promise((r) => setTimeout(r, 250));
			assert.equal(fs.existsSync(home), false, "detached shutdown helper must not recreate temp folder");
		} finally {
			await stopProcessGroup(child).catch(() => {});
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("times GET /api/chats/:id?view=coverage in the benchmark route list", () => {
		const src = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/bench-chat-switch.mjs"), "utf8");
		assert.match(src, /\?view=coverage/, "benchmark must time ?view=coverage");
	});
});
