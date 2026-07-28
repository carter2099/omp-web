/**
 * 10-minute idle destroy timer shared by AgentSessionWrapper.
 * Extracted so unit tests can inject fake timers without a full session.
 */

export type IdleTimer = {
	readonly reset: () => void;
	readonly clear: () => void;
};

export type IdleTimerOptions = {
	readonly idleMs: number;
	readonly isRunning: () => boolean;
	readonly onIdle: () => void;
	readonly setTimeoutFn?: typeof setTimeout;
	readonly clearTimeoutFn?: typeof clearTimeout;
};

export function createIdleTimer(options: IdleTimerOptions): IdleTimer {
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	let handle: ReturnType<typeof setTimeout> | null = null;

	const clear = (): void => {
		if (handle !== null) {
			clearTimeoutFn(handle);
			handle = null;
		}
	};

	const reset = (): void => {
		clear();
		handle = setTimeoutFn(() => {
			if (options.isRunning()) {
				reset();
				return;
			}
			options.onIdle();
		}, options.idleMs);
	};

	return { reset, clear };
}
