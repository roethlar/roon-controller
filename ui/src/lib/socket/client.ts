import { browser } from '$app/environment';
import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export const getSocket = (): Socket | null => {
	if (!browser) {
		return null;
	}

	if (!socket) {
		socket = io({
			path: '/socket.io',
			transports: ['websocket']
		});
	}

	return socket;
};

export const disconnectSocket = (): void => {
	if (socket) {
		socket.disconnect();
		socket = null;
	}
};
