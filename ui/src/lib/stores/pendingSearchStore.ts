import { writable } from 'svelte/store';

/** A search query set by the play bar that the library page should execute on next mount or reactively. */
export const pendingSearchStore = writable<string | null>(null);
