/**
 * Minimal Vite config for local acceptance demos.
 *
 * The repository's canonical build config (scripts/build/vite.config.js) is not
 * part of this snapshot. This config only serves the demo pages in dev mode:
 * it stubs the project-specific `/@hmr-style-imports` virtual module and relies
 * on Vite's built-in SCSS and `?worker&inline` handling.
 */
import { defineConfig } from 'vite';

export default defineConfig({
    root: '.',
    server: {
        port: 5199,
        strictPort: false,
        open: false
    },
    plugins: [
        {
            name: 'visionplayer-hmr-style-stub',
            resolveId(id) {
                if (id === '/@hmr-style-imports') return '\0hmr-style-imports';
                return null;
            },
            load(id) {
                if (id === '\0hmr-style-imports') return 'export default {};';
                return null;
            }
        }
    ]
});
