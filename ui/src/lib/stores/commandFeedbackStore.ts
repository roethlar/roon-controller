import { writable } from 'svelte/store';

export type CommandSource = 'transport' | 'browse';

export interface CommandFeedback {
	readonly source: CommandSource;
	readonly command: string;
	readonly message: string;
	readonly timestamp: number;
}

const internalStore = writable<CommandFeedback | null>(null);

export const commandFeedbackStore = {
	subscribe: internalStore.subscribe
};

export function pushCommandFeedback(feedback: Omit<CommandFeedback, 'timestamp'>): void {
	internalStore.set({
		...feedback,
		timestamp: Date.now()
	});
}

export function clearCommandFeedback(): void {
	internalStore.set(null);
}
