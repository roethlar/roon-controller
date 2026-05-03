import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import userEvent from '@testing-library/user-event';
import Search from '../Search.svelte';
import type { SearchResult } from '@shared/types';

// Mock socket client so the component doesn't try to open a real socket.
const fakeSocket = {
	emit: vi.fn(),
	on: vi.fn(),
	off: vi.fn(),
	connected: true
};
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket
}));

import {
	setSearchResults,
	setSearchLoading,
	clearSearchResults
} from '$lib/stores/browseStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';

function makeResult(over: Partial<SearchResult> & { resultType: SearchResult['resultType'] }): SearchResult {
	return {
		title: 'Untitled',
		isLoadable: true,
		isPlayable: false,
		itemKey: 'k',
		...over
	};
}

beforeEach(() => {
	clearSearchResults();
	setSelectedZone('');
	fakeSocket.emit.mockClear();
});

describe('Search component', () => {
	it('renders nothing while no search has run', () => {
		render(Search);
		expect(screen.queryByText(/results/i)).toBeNull();
	});

	it('shows "Searching..." while loading', async () => {
		render(Search);
		setSearchLoading('beatles');
		await tick();
		expect(screen.getByText(/searching/i)).toBeInTheDocument();
	});

	it('groups results by type in the documented order', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'track', title: 'T1', itemKey: 't1' }),
			makeResult({ resultType: 'album', title: 'A1', itemKey: 'a1' }),
			makeResult({ resultType: 'artist', title: 'AR1', itemKey: 'ar1' }),
			makeResult({ resultType: 'album', title: 'A2', itemKey: 'a2' })
		]);
		await tick();

		const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
		expect(headings).toEqual(['Artists', 'Albums', 'Tracks']);
	});

	it('shows the submitted query in the result count', async () => {
		render(Search);
		setSearchLoading('beatles');
		setSearchResults([makeResult({ resultType: 'album', title: 'A1', itemKey: 'a1' })]);
		await tick();

		expect(screen.getByText(/1 results/i)).toBeInTheDocument();
		expect(screen.getByText('"beatles"')).toBeInTheDocument();
	});

	it('paginates per group at 12 with a "Show more" button', async () => {
		const albums = Array.from({ length: 20 }, (_, i) =>
			makeResult({ resultType: 'album', title: `Album ${i + 1}`, itemKey: `a${i}` })
		);
		render(Search);
		setSearchResults(albums);
		await tick();

		// First 12 visible
		expect(screen.getByText('Album 1')).toBeInTheDocument();
		expect(screen.getByText('Album 12')).toBeInTheDocument();
		expect(screen.queryByText('Album 13')).toBeNull();
		expect(screen.getByText(/12 of 20/)).toBeInTheDocument();

		// Show more bumps to 24 (capped at 20)
		await userEvent.click(screen.getByRole('button', { name: /show more albums/i }));
		expect(screen.getByText('Album 20')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /show more albums/i })).toBeNull();
	});

	it('fires the onResultClick callback with the clicked result', async () => {
		const onResultClick = vi.fn();
		render(Search, { onResultClick });
		const result = makeResult({ resultType: 'album', title: 'Pet Sounds', itemKey: 'k1' });
		setSearchResults([result]);
		await tick();

		await userEvent.click(screen.getByText('Pet Sounds'));
		expect(onResultClick).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'k1' }));
	});

	it('disables result buttons that have no itemKey', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'album', title: 'No key', itemKey: undefined })
		]);
		await tick();

		const titleEl = screen.getByText('No key');
		const button = titleEl.closest('button');
		expect(button).toBeDisabled();
	});

	it('emits browse:search via socket when the user submits a query', async () => {
		render(Search);
		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await userEvent.type(input, 'beatles');
		await userEvent.click(screen.getByRole('button', { name: /^search$/i }));

		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:search',
			expect.objectContaining({ input: 'beatles', popAll: true })
		);
	});

	it('does not emit when the query is whitespace', async () => {
		render(Search);
		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await userEvent.type(input, '   ');
		const button = screen.getByRole('button', { name: /^search$/i });
		expect(button).toBeDisabled();
		expect(fakeSocket.emit).not.toHaveBeenCalled();
	});

	it('resets per-group pagination when the query changes', async () => {
		const albums = Array.from({ length: 20 }, (_, i) =>
			makeResult({ resultType: 'album', title: `Album ${i + 1}`, itemKey: `a${i}` })
		);
		render(Search);
		setSearchLoading('first');
		setSearchResults(albums);
		await tick();

		await userEvent.click(screen.getByRole('button', { name: /show more albums/i }));
		expect(screen.getByText('Album 20')).toBeInTheDocument();

		// New query lands — group should re-collapse to first page.
		setSearchLoading('second');
		setSearchResults(albums);
		await tick();
		expect(screen.queryByText('Album 20')).toBeNull();
		expect(screen.getByText('Album 12')).toBeInTheDocument();
	});
});
