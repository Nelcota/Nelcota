import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

// SvelteKit 3 takes the trusted origin (url.origin, CSRF checks) from the build
// configuration. Set ORIGIN when building, e.g. ORIGIN=https://app.example.com.
export default { plugins: [sveltekit({ adapter: adapter(), paths: { origin: process.env.ORIGIN } })] };
