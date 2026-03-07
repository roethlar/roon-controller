import { writable } from 'svelte/store';

const internalStore = writable<string>('');

export const selectedZoneStore = {
	subscribe: internalStore.subscribe
};

export function setSelectedZone(zoneId: string): void {
	internalStore.set(zoneId);
}
