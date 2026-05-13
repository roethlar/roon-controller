// Stub for SvelteKit's `$app/navigation` module under Vitest. Tests
// that exercise `goto`/`invalidate` should `vi.mock('$app/navigation')`
// to inject their own mocks; this file just satisfies the vite import
// resolver so .svelte files compile.
export const goto = async (_url: string): Promise<void> => {};
export const invalidate = async (_url?: string): Promise<void> => {};
export const invalidateAll = async (): Promise<void> => {};
export const beforeNavigate = (_fn: () => void): void => {};
export const afterNavigate = (_fn: () => void): void => {};
