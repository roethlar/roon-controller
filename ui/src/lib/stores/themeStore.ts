import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'roon-controller-theme';

function detectInitialTheme(): ThemeMode {
	if (!browser) {
		return 'dark';
	}

	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'dark' || stored === 'light') {
		return stored;
	}

	return 'dark';
}

const internalStore = writable<ThemeMode>(detectInitialTheme());

export const themeStore = {
	subscribe: internalStore.subscribe
};

export function applyTheme(theme: ThemeMode): void {
	if (!browser) {
		return;
	}

	document.documentElement.setAttribute('data-theme', theme);
	localStorage.setItem(STORAGE_KEY, theme);
}

export function setTheme(theme: ThemeMode): void {
	internalStore.set(theme);
	applyTheme(theme);
}

export function initializeTheme(): void {
	const theme = detectInitialTheme();
	applyTheme(theme);
	internalStore.set(theme);
}

export function toggleTheme(): void {
	internalStore.update((current) => {
		const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		return next;
	});
}
