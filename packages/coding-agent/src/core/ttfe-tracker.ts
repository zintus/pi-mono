/**
 * Per-model time-to-first-event (TTFE) latency tracker.
 *
 * Each model key gets a bounded circular buffer of recent successful TTFEs.
 * The derived adaptive cap is:
 *
 *     cap = min(hardCapMs, max(kMedian × median, tailMargin × p99))
 *
 * before warmup (fewer than `warmupN` samples) the cap is the hard cap so the
 * watchdog only triggers on pathological stalls.
 */

export interface ResilientStreamConfig {
	/** Absolute upper bound on how long to wait for the first event. */
	hardCapMs: number;
	/** Number of samples required before the adaptive cap kicks in. */
	warmupN: number;
	/** Circular-buffer capacity per model. */
	bufN: number;
	/** Multiplier on the sample median (floor for the adaptive cap). */
	kMedian: number;
	/** Multiplier on the sample p99 (tail term for the adaptive cap). */
	tailMargin: number;
	/** Probability of an exploration attempt that uses the hard cap only. */
	exploreP: number;
	/** Max attempts per stream() call, including the first one. */
	maxAttempts: number;
}

export const DEFAULT_RESILIENT_STREAM_CONFIG: ResilientStreamConfig = {
	hardCapMs: 90_000,
	warmupN: 10,
	bufN: 500,
	kMedian: 10,
	tailMargin: 1.1,
	exploreP: 0.05,
	maxAttempts: 3,
};

export class TTFETracker {
	private buffers = new Map<string, number[]>();

	record(modelKey: string, ttfeMs: number, bufN = DEFAULT_RESILIENT_STREAM_CONFIG.bufN): void {
		let buf = this.buffers.get(modelKey);
		if (!buf) {
			buf = [];
			this.buffers.set(modelKey, buf);
		}
		buf.push(ttfeMs);
		if (buf.length > bufN) buf.splice(0, buf.length - bufN);
	}

	capFor(modelKey: string, config: ResilientStreamConfig): number {
		const buf = this.buffers.get(modelKey);
		if (!buf || buf.length < config.warmupN) return config.hardCapMs;
		const sorted = [...buf].sort((a, b) => a - b);
		const n = sorted.length;
		const median = sorted[Math.floor(n * 0.5)];
		const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
		const floor = config.kMedian * median;
		const tail = config.tailMargin * p99;
		return Math.min(config.hardCapMs, Math.ceil(Math.max(floor, tail)));
	}
}
