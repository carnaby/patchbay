import { defineConfig } from 'vitest/config';

// Unit tests for the web app's pure logic and stores; they run in Node, without a DOM or the Vite plugins.
export default defineConfig({ test: { name: 'web', include: ['src/**/*.test.ts'] } });
