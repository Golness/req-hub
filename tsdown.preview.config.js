import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/client/preview-entry.js'],
  format: 'iife',
  platform: 'browser',
  outDir: 'lib',
  fileName: 'preview-bundle',
  external: ['react', 'react-dom'],
  globals: {
    react: 'React',
    'react-dom': 'ReactDOM',
  },
  minify: false,
  sourcemap: false,
  clean: false,
});
