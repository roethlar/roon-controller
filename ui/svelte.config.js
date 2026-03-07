import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Serve index.html for any path not matched by a static file,
			// so SvelteKit's client-side router handles deep-linking.
			fallback: 'index.html',
			precompress: false
		}),
		alias: {
			'@shared': path.resolve('../src/shared')
		}
	}
};

export default config;
