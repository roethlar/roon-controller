import type {
	BrowseOptions,
	BrowseLoadOptions,
	BrowsePopOptions,
	BrowseResult,
	BrowseSearchOptions,
	CoreStatusResponse,
	ErrorResponse,
	SearchResult,
	ZonesResponse
} from '@shared/types';

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

type FetchLike = typeof fetch;

async function request<T>(fetchFn: FetchLike, input: RequestInfo, init?: RequestInit): Promise<T> {
	const response = await fetchFn(input, {
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...init?.headers
		},
		...init
	});

	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			body = await response.text();
		}
		const message = (body as ErrorResponse)?.error ?? response.statusText;
		throw new ApiError(message, response.status, body);
	}

	return (await response.json()) as T;
}

export function fetchCoreStatus(fetchFn: FetchLike): Promise<CoreStatusResponse> {
	return request<CoreStatusResponse>(fetchFn, '/api/core');
}

export async function fetchZones(fetchFn: FetchLike): Promise<ZonesResponse['zones']> {
	const { zones } = await request<ZonesResponse>(fetchFn, '/api/zones');
	return zones;
}

export function browse(fetchFn: FetchLike, options: BrowseOptions): Promise<BrowseResult> {
	return request<BrowseResult>(fetchFn, '/api/browse', {
		method: 'POST',
		body: JSON.stringify(options)
	});
}

export function browseLoad(fetchFn: FetchLike, options: BrowseLoadOptions): Promise<BrowseResult> {
	return request<BrowseResult>(fetchFn, '/api/browse/load', {
		method: 'POST',
		body: JSON.stringify(options)
	});
}

export function browsePop(fetchFn: FetchLike, options: BrowsePopOptions): Promise<BrowseResult> {
	return request<BrowseResult>(fetchFn, '/api/browse/pop', {
		method: 'POST',
		body: JSON.stringify(options)
	});
}

export function browseSearch(fetchFn: FetchLike, options: BrowseSearchOptions): Promise<SearchResult[]> {
	return request<SearchResult[]>(fetchFn, '/api/browse/search', {
		method: 'POST',
		body: JSON.stringify(options)
	});
}
