import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ErrorToast from '../ErrorToast.svelte';
import {
	pushCommandFeedback,
	clearCommandFeedback
} from '$lib/stores/commandFeedbackStore';

beforeEach(() => {
	clearCommandFeedback();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ErrorToast', () => {
	it('renders nothing when no feedback is set', () => {
		render(ErrorToast);
		expect(screen.queryByRole('button', { name: /✕/ })).toBeNull();
	});

	it('renders a transport error with the right label', async () => {
		render(ErrorToast);
		pushCommandFeedback({
			source: 'transport',
			command: 'transport:play-pause',
			message: 'Roon rejected the command'
		});
		expect(await screen.findByText(/playback error/i)).toBeInTheDocument();
		expect(screen.getByText('Roon rejected the command')).toBeInTheDocument();
		expect(screen.getByText(/transport:play-pause/)).toBeInTheDocument();
	});

	it('renders queue / browse errors with the right label', async () => {
		const { unmount } = render(ErrorToast);
		pushCommandFeedback({ source: 'queue', command: 'queue:play-from-here', message: 'q err' });
		expect(await screen.findByText(/queue error/i)).toBeInTheDocument();
		unmount();

		render(ErrorToast);
		pushCommandFeedback({ source: 'browse', command: 'browse:browse', message: 'b err' });
		expect(await screen.findByText(/browse error/i)).toBeInTheDocument();
	});

	it('clears via the dismiss button', async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(ErrorToast);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'oops' });
		expect(await screen.findByText('oops')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: '✕' }));
		expect(screen.queryByText('oops')).toBeNull();
	});

	it('auto-clears after 5 seconds', async () => {
		render(ErrorToast);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'fades' });
		expect(await screen.findByText('fades')).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(5000);
		expect(screen.queryByText('fades')).toBeNull();
	});
});
