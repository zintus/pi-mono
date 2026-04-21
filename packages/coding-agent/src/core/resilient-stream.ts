import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	type StopReason,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { DEFAULT_RESILIENT_STREAM_CONFIG, type ResilientStreamConfig, TTFETracker } from "./ttfe-tracker.ts";

export interface ResilientStreamOptions {
	tracker?: TTFETracker;
	config?: Partial<ResilientStreamConfig>;
}

const globalTracker = new TTFETracker();

/**
 * Wrap a StreamFunction with TTFE-based retry.
 *
 * - Records time-to-first-event per (provider, model) in a circular-buffer histogram.
 * - Computes an adaptive cap: min(hardCap, max(kMedian × median, tailMargin × p99)).
 *   Before warmup or on exploration episodes, uses the hard cap only.
 * - If the first event does not arrive within the cap, aborts the inner stream
 *   via an internal AbortController and retries (up to maxAttempts).
 * - Mid-stream failures (anything after the first event) are NOT retried —
 *   the event passes through unchanged.
 * - A user-provided signal wins: if it aborts, no retry happens and an aborted
 *   error event is surfaced to the caller.
 * - Synchronous throws from the inner stream function and rejections from its
 *   iterator are caught and converted to a terminal error event on the outer
 *   stream so the caller's `result()` promise always resolves.
 */
export function makeResilientStreamFn<TApi extends Api>(
	inner: StreamFunction<TApi>,
	options: ResilientStreamOptions = {},
): StreamFunction<TApi> {
	const tracker = options.tracker ?? globalTracker;
	const cfg: ResilientStreamConfig = {
		...DEFAULT_RESILIENT_STREAM_CONFIG,
		...options.config,
	};

	return (model, context, opts) => {
		const outer = createAssistantMessageEventStream();
		const trackerKey = `${model.provider}:${model.id}`;

		(async () => {
			const userSignal = opts?.signal;
			let lastError: AssistantMessageEvent | undefined;

			try {
				for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
					if (userSignal?.aborted) {
						finalizeUserAborted(outer, model);
						return;
					}

					const watchdog = new AbortController();
					const mergedSignal: AbortSignal = userSignal
						? AbortSignal.any([userSignal, watchdog.signal])
						: watchdog.signal;

					const explore = Math.random() < cfg.exploreP;
					const cap = explore ? cfg.hardCapMs : tracker.capFor(trackerKey, cfg);

					let firstEventSeen = false;
					const startTime = Date.now();
					const timer = setTimeout(() => {
						if (!firstEventSeen) watchdog.abort();
					}, cap);

					let retryThisAttempt = false;
					try {
						const innerStream = inner(model, context, {
							...(opts ?? {}),
							signal: mergedSignal,
						} as typeof opts);

						for await (const ev of innerStream) {
							// TTFE timeout: we aborted before any event arrived.
							// The provider's resulting error event is ours to swallow — retry.
							if (
								ev.type === "error" &&
								ev.reason === "aborted" &&
								watchdog.signal.aborted &&
								!userSignal?.aborted &&
								!firstEventSeen
							) {
								retryThisAttempt = true;
								lastError = ev;
								break;
							}

							if (!firstEventSeen && ev.type !== "error") {
								firstEventSeen = true;
								clearTimeout(timer);
								tracker.record(trackerKey, Date.now() - startTime, cfg.bufN);
							}

							outer.push(ev);
						}
					} finally {
						clearTimeout(timer);
					}

					if (retryThisAttempt && attempt < cfg.maxAttempts && !userSignal?.aborted) {
						continue;
					}

					if (retryThisAttempt && userSignal?.aborted) {
						finalizeUserAborted(outer, model);
						return;
					}

					if (retryThisAttempt && lastError) {
						// Exhausted: surface the last TTFE-timeout error to the caller.
						outer.push(lastError);
					}
					outer.end();
					return;
				}
			} catch (error) {
				// Inner stream threw synchronously or its iterator rejected.
				// Convert to a terminal error event so outer.result() always resolves.
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				const errored = buildErrorMessage(model, "error", message);
				outer.push({ type: "error", reason: "error", error: errored });
				outer.end();
				return;
			}

			// Defensive: loop fell through without returning (shouldn't happen).
			outer.end();
		})();

		return outer;
	};
}

function finalizeUserAborted(outer: ReturnType<typeof createAssistantMessageEventStream>, model: Model<Api>): void {
	const errored = buildErrorMessage(model, "aborted", "Request aborted by caller");
	outer.push({ type: "error", reason: "aborted", error: errored });
	outer.end();
}

function buildErrorMessage(
	model: Model<Api>,
	stopReason: Extract<StopReason, "aborted" | "error">,
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}
