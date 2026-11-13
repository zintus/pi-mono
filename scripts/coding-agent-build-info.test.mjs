import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { writeBuildInfo } from "./write-coding-agent-build-info.mjs";

function git(root, ...args) {
	return execFileSync("git", [
		"-C", root,
		"-c", "user.name=Build Info Test",
		"-c", "user.email=build-info@example.invalid",
		"-c", "commit.gpgsign=false",
		"-c", `core.hooksPath=${join(root, "empty-hooks")}`,
		...args,
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-build-info-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--quiet");
	writeFileSync(join(root, ".gitignore"), "dist/\nempty-hooks/\n");
	writeFileSync(join(root, "source.txt"), "original\n");
	git(root, "add", ".gitignore", "source.txt");
	git(root, "commit", "--quiet", "-m", "test: initial fixture");
	return { root, output: join(root, "dist/build-info.mjs"), commit: git(root, "rev-parse", "HEAD") };
}

function runInfoModule(output) {
	return JSON.parse(execFileSync(process.execPath, [
		"--input-type=module", "--eval",
		`import { BUILD_INFO } from ${JSON.stringify(pathToFileURL(output).href)}; console.log(JSON.stringify(BUILD_INFO));`,
	], { encoding: "utf8" }));
}

test("captures a clean commit and does not consult Git again at runtime", (t) => {
	const { root, output, commit } = fixture(t);
	assert.deepEqual(writeBuildInfo(root, output), { gitCommit: commit, dirty: false });
	assert.deepEqual(runInfoModule(output), { gitCommit: commit, dirty: false });
	writeFileSync(join(root, "source.txt"), "updated\n");
	git(root, "add", "source.txt");
	git(root, "commit", "--quiet", "-m", "test: advance fixture");
	assert.notEqual(git(root, "rev-parse", "HEAD"), commit);
	assert.deepEqual(runInfoModule(output), { gitCommit: commit, dirty: false });
});

for (const kind of ["unstaged", "staged", "untracked"]) {
	test(`marks a ${kind} source change as dirty`, (t) => {
		const { root, output, commit } = fixture(t);
		writeFileSync(join(root, kind === "untracked" ? "new-source.txt" : "source.txt"), "changed\n");
		if (kind === "staged") git(root, "add", "source.txt");
		assert.deepEqual(writeBuildInfo(root, output), { gitCommit: commit, dirty: true });
		assert.deepEqual(runInfoModule(output), { gitCommit: commit, dirty: true });
	});
}

test("supports worktrees whose .git is a file", (t) => {
	const { root, commit } = fixture(t);
	const worktree = join(root, "dist/worktree");
	git(root, "worktree", "add", "--quiet", "--detach", worktree);
	assert.deepEqual(writeBuildInfo(worktree, join(worktree, "dist/build-info.mjs")), {
		gitCommit: commit,
		dirty: false,
	});
});

test("reports unknown provenance for archives instead of using an enclosing repository", (t) => {
	const { root } = fixture(t);
	const archive = join(root, "dist/archive");
	mkdirSync(archive, { recursive: true });
	const output = join(archive, "dist/build-info.mjs");
	assert.deepEqual(writeBuildInfo(archive, output), { gitCommit: null, dirty: null });
	assert.deepEqual(runInfoModule(output), { gitCommit: null, dirty: null });
	writeFileSync(join(archive, ".git"), "gitdir: /nonexistent/pi-build-info-gitdir\n");
	assert.deepEqual(writeBuildInfo(archive, output), { gitCommit: null, dirty: null });
});

test("the package build stamps compiled output before bundling", () => {
	const manifest = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
	assert.match(manifest.scripts["build:unbundled"], /tsc .* && node ..\/..\/scripts\/write-coding-agent-build-info\.mjs/);
	assert.match(manifest.scripts.build, /^npm run build:unbundled && node .*build-coding-agent-bundle\.mjs$/);
});

const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
test("Bun binaries embed provenance independently of the source checkout", { skip: !hasBun }, (t) => {
	const { root, output, commit } = fixture(t);
	writeBuildInfo(root, output);
	const entry = join(root, "dist/entry.mjs");
	writeFileSync(entry, 'import { BUILD_INFO } from "./build-info.mjs"; console.log(JSON.stringify(BUILD_INFO));\n');
	const binary = join(root, process.platform === "win32" ? "dist/provenance.exe" : "dist/provenance");
	execFileSync("bun", ["build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", binary], {
		cwd: root, stdio: ["ignore", "pipe", "pipe"],
	});
	rmSync(join(root, ".git"), { recursive: true, force: true });
	rmSync(output);
	const result = JSON.parse(execFileSync(binary, { cwd: tmpdir(), encoding: "utf8" }));
	assert.deepEqual(result, { gitCommit: commit, dirty: false });
});
