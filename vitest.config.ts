import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Two projects (REVIEW-1 R1-13).
 *
 * `server` runs plain `.test.ts` files in Node with the `react-server` export
 * condition, as skylite does. A module marked `import 'server-only'` resolves,
 * under the default condition, to a file whose only job is to throw. The
 * `react-server` condition points it at its no-op entry, the same file a server
 * build uses, so server modules are tested as the server sees them. This lives
 * under `ssr` because Vitest loads these modules through Vite's SSR pipeline,
 * which keeps its own condition list; `module` and `node` are repeated because
 * naming any condition replaces the default list.
 *
 * `ui` runs `.test.tsx` files, plus the React hooks under src/lib/hooks and
 * src/lib/presence, in jsdom with the default conditions, so components and
 * hooks render the way they do in a browser. JSX uses the automatic runtime.
 * Vitest 4 resolves Vite 8 here, which transforms with Oxc and ignores the
 * older `esbuild.jsx` option, so the setting is `oxc.jsx.runtime`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/lib/hooks/**', 'src/lib/presence/**'],
        },
        ssr: {
          resolve: {
            conditions: ['react-server', 'module', 'node'],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: [
            'src/**/*.test.tsx',
            'src/lib/hooks/**/*.test.ts',
            'src/lib/presence/**/*.test.ts',
          ],
        },
        oxc: {
          jsx: {
            runtime: 'automatic',
          },
        },
      },
    ],
  },
})
