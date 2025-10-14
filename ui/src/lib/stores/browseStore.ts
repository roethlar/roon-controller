import { writable } from 'svelte/store';
import type { BrowseResult, SearchResult } from '@shared/types';

export interface BrowseState {
	current: BrowseResult | null;
	hierarchy: string;
	lastSearch: SearchResult[] | null;
	loading: boolean;
	error: string | null;
}

const initialState: BrowseState = {
	current: null,
	hierarchy: 'browse',
	lastSearch: null,
	loading: false,
	error: null
};

const internalStore = writable<BrowseState>(initialState);

export const browseStore = {
	subscribe: internalStore.subscribe
};

export function setBrowseResult(result: BrowseResult, hierarchy?: string): void {
	internalStore.update((state) => ({
		current: result,
		hierarchy: hierarchy ?? state.hierarchy,
		lastSearch: null,
		loading: false,
		error: null
	}));
}

export function setSearchResults(results: SearchResult[]): void {
	internalStore.update((state) => ({
		...state,
		hierarchy: 'search',
		lastSearch: results,
		loading: false,
		error: null
	}));
}

export function setBrowseLoading(hierarchy?: string): void {
	internalStore.update((state) => ({
		...state,
		hierarchy: hierarchy ?? state.hierarchy,
		loading: true,
		error: null
	}));
}

export function setBrowseError(message: string): void {
	internalStore.update((state) => ({
		...state,
		loading: false,
		error: message
	}));
}

export function resetBrowse(): void {
	internalStore.set(initialState);
}
