import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { VERSION } from "../src/config.ts";
import { main } from "../src/main.ts";

const buildInfo = vi.hoisted(() => ({ gitCommit: "a".repeat(40) as string | null, dirty: true as boolean | null }));
vi.mock("../src/build-info.ts", () => ({ BUILD_INFO: buildInfo }));

describe("build provenance CLI", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-build-info-cli-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		buildInfo.gitCommit = "a".repeat(40);
		buildInfo.dirty = true;
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("CLI exit");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("recognizes --build-info without treating it as an extension flag", () => {
		const parsed = parseArgs(["--build-info"]);
		expect(parsed.buildInfo).toBe(true);
		expect(parsed.unknownFlags.size).toBe(0);
		expect(parseArgs(["--", "--build-info"]).buildInfo).toBeUndefined();
	});

	it("prints captured version, commit, and dirty state as JSON", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(main(["--build-info"])).rejects.toThrow("CLI exit");
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ version: VERSION, ...buildInfo });
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("keeps --version as plain semver for update checks", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(main(["--version"])).rejects.toThrow("CLI exit");
		expect(log).toHaveBeenCalledExactlyOnceWith(VERSION);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it("reports unknown rather than inventing provenance for unstamped builds", async () => {
		buildInfo.gitCommit = null;
		buildInfo.dirty = null;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(main(["--build-info"])).rejects.toThrow("CLI exit");
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ version: VERSION, gitCommit: null, dirty: null });
	});
});
