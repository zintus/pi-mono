import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

describe("SSE JSON parse error auto-retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it('retries transient "JSON Parse error: Unterminated string" failures', async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "JSON Parse error: Unterminated string",
			}),
			fauxAssistantMessage("recovered after parse retry"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			"JSON Parse error: Unterminated string",
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness)).toContain("recovered after parse retry");
	});

	it('retries transient "Property name must be a string literal" failures', async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Property name must be a string literal at line 1 column 2",
			}),
			fauxAssistantMessage("recovered after property-name retry"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			"Property name must be a string literal at line 1 column 2",
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness)).toContain("recovered after property-name retry");
	});
});
