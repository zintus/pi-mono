#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Capture this checkout's revision in an emitted module, never in tracked sources. */
export function writeBuildInfo(repoRoot, outputPath) {
	let info = { gitCommit: null, dirty: null };
	// A source archive inside another repository must not inherit that parent's revision.
	if (existsSync(join(repoRoot, ".git"))) {
		try {
			const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
			info = {
				gitCommit: git("rev-parse", "--verify", "HEAD"),
				dirty: git("status", "--porcelain", "--untracked-files=normal").length > 0,
			};
		} catch {
			// Git may be unavailable, or this may be an archive with stale .git metadata.
			// Unknown is distinct from a clean build of a known commit.
		}
	}
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `export const BUILD_INFO = ${JSON.stringify(info)};\n`);
	return info;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	const repoRoot = resolve(dirname(scriptPath), "..");
	writeBuildInfo(repoRoot, join(repoRoot, "packages/coding-agent/dist/build-info.js"));
}
