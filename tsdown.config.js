/**
 * ReqHub tsdown build configuration
 *
 * DSH expects CJS closure-factory format wrapped in __ModuleLoader__.load().
 * See: packages/client/tsdown.client.ts in deepseek-harness
 *
 * Output shape:
 *   window.__ModuleLoader__.load({ id: "...", factory: function(require) {
 *     var module = { exports: {} }; var exports = module.exports;
 *     <bundled CJS body>
 *     return module.exports;
 *   } });
 */

import { stat, utimes, readFile } from 'node:fs/promises';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { Rolldown } from 'tsdown';
import { transform } from 'lightningcss';

const PLUGIN_ID = '@local/req-hub';

// Platform modules provided by DSH host — must stay external
// Source: packages/client/web/src/platform.ts in deepseek-harness
// NOTE: @deepseek-ai/dsh-client-ui-layout and sidebar-right are NOT platform modules;
// they are independent Cordis dynamic plugins (declared via dsh.client.external).
const PLATFORM_EXTERNALS = [
  // React core
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',

  // Cordis framework
  '@deepseek-ai/cordis',

  // DSH client modules
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

// CSS virtual module prefixes (must match DSH official)
// Source: packages/client/tsdown.client.ts lines 29-33
const CSS_VIRTUAL_PREFIX = '\0dsh-css:';
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:';
const CSS_VIRTUAL_SUFFIX = '.mjs';

/**
 * Generate DSH-compliant style injection module
 * Source: packages/client/tsdown.client.ts lines 36-56
 */
function styleInjectionModule(id, fileId, css, classMap) {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ];
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`);
  return source.join('\n');
}

/**
 * CSS plugin: handles plain .css files (global styles)
 * Uses GLOBAL_CSS_VIRTUAL_PREFIX (consistent with DSH official)
 */
function cssGlobalInlinePlugin(id) {
  return {
    name: 'dsh-css-global-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null;
      const abs = importer ? resolvePath(dirname(importer), source) : source;
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
    },
    async load(virtualId) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null;
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
      this.addWatchFile(fileId);
      const source = await readFile(fileId);
      const { code } = transform({ filename: fileId, code: source, minify: true });
      return styleInjectionModule(id, fileId, code.toString());
    },
  };
}

/**
 * CSS plugin: handles .module.css files (CSS Modules)
 * Uses CSS_VIRTUAL_PREFIX (consistent with DSH official)
 */
function cssModulesInlinePlugin(id) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null;
      const abs = importer ? resolvePath(dirname(importer), source) : source;
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
      this.addWatchFile(fileId);
      const source = await readFile(fileId);
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      });
      const classMap = {};
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      for (const [local, exp] of exportEntries) classMap[local] = exp.name;
      return styleInjectionModule(id, fileId, code.toString(), classMap);
    },
  };
}

/**
 * Rollup plugin to rewrite import() to require.async()
 *
 * DSH official implementation: packages/client/tsdown.client.ts lines 438-471
 *
 * How it works:
 * 1. tsdown compiles import('./chunk.js') to Promise.resolve().then(() => require("./chunk.js"))
 * 2. This plugin scans chunk.dynamicImports and finds matching chunk filenames
 * 3. Uses RolldownMagicString for precise replacement
 * 4. DSH runtime loads chunks via require.async
 */
function asyncChunkRequirePlugin() {
  return {
    name: 'dsh-client-async-chunk-require',

    renderChunk(code, chunk, outputOptions) {
      // Only process CJS format
      if (outputOptions.format !== 'cjs') return null;

      // Use RolldownMagicString for precise replacement (consistent with DSH official)
      const transformed = new Rolldown.RolldownMagicString(code);

      // Iterate all dynamic imports
      for (const dynamicImport of chunk.dynamicImports) {
        // Extract filename (remove ./ prefix)
        const fileName = dynamicImport.startsWith('./')
          ? dynamicImport.slice(2)
          : dynamicImport;

        // Validate chunk filename against DSH spec
        if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) {
          continue;
        }

        const specifier = `./${fileName}`;

        // Build match regex (matches tsdown generated code format)
        const callPattern = new RegExp(
          `Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${escapeRegExp(specifier)}\\1\\)\\)`,
          'gu',
        );

        // Find all matches
        const matches = [...code.matchAll(callPattern)];

        if (matches.length === 0) {
          // DSH throws error, not just warns
          throw new Error(`client bundle compiler: dynamic chunk ${JSON.stringify(specifier)} has no generated import expression`);
        }

        // Precise replacement
        for (const match of matches) {
          const start = match.index;
          const end = start + match[0].length;
          transformed.overwrite(start, end, `require.async(${JSON.stringify(specifier)})`);
        }
      }

      return transformed.hasChanged() ? transformed : null;
    },

    // writeBundle hook: update entry file mtime for HMR
    // Source: packages/client/tsdown.client.ts lines 462-469
    // HMR watcher polls entry file stats (mtimeMs/ctimeMs/size) every 500ms.
    // chunk-only rebuilds don't change entry content but need to advance mtime
    // to trigger revision updates.
    async writeBundle(outputOptions, bundle) {
      const entry = Object.values(bundle).find(output => output.type === 'chunk' && output.isEntry);
      if (entry === undefined || outputOptions.dir === undefined) return;
      const entryPath = resolvePath(outputOptions.dir, entry.fileName);
      const current = await stat(entryPath);
      const completedAt = new Date(Math.max(Date.now(), current.mtimeMs + 1));
      await utimes(entryPath, current.atime, completedAt);
    },
  };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  name: 'req-hub/client',

  // Entry file
  entry: { client: 'src/client/index.js' },

  // Output directory
  outDir: 'lib',

  // Output format: CJS (required by DSH)
  format: 'cjs',

  // Target platform: browser
  platform: 'browser',

  // Don't generate .d.ts (DSH plugins don't need type declarations)
  dts: false,

  // Enable source maps
  sourcemap: true,

  // Don't clean output directory (consistent with DSH official, avoids clearing Node output)
  clean: false,

  // Disable @tsdown/css — CSS is handled by our Rolldown plugins
  css: false,

  // Dependency handling
  deps: {
    // Keep platform modules external (don't bundle)
    neverBundle: PLATFORM_EXTERNALS,

    // Bundle everything else
    alwaysBundle: (specifier) => !PLATFORM_EXTERNALS.includes(specifier),
  },

  // Module resolution configuration
  inputOptions: {
    // tsdown defaults CJS builds to Node; DSH's CJS loader runs in the browser.
    platform: 'browser',
    resolve: {
      // Conditional resolution names (ensure dual-mode libraries resolve correctly)
      conditionNames: [
        process.env.NODE_ENV === 'development' ? 'development' : 'production',
        'browser',
        'import',
        'module',
        'default',
      ],
    },
  },

  // Global constant replacements
  define: {
    // Empty object definition (consistent with DSH official, avoids ReferenceError on process.env.XXX)
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    // DSH official also spreads clientBuildEnvironmentDefines(process.env) for DSH_CLIENT_* vars.
    // Third-party plugins usually don't need these. Add manually if needed:
    // 'process.env.DSH_CLIENT_VERSION': JSON.stringify(process.env.DSH_CLIENT_VERSION ?? ''),
  },

  // Plugins
  plugins: [
    // Dynamic import rewriting (must run after deps plugin)
    asyncChunkRequirePlugin(),
    // CSS handling (consistent with DSH official)
    cssGlobalInlinePlugin(PLUGIN_ID),
    cssModulesInlinePlugin(PLUGIN_ID),
  ],

  // Output options
  outputOptions: {
    // Entry filename
    entryFileNames: 'client.js',

    // Chunk filename (must comply with DSH spec)
    chunkFileNames: 'client.[name].js',

    // Banner: dynamically generated based on chunk type
    banner: (chunk) => {
      if (chunk.isEntry) {
        // Entry file: no chunk field
        return `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`;
      } else {
        // Chunk file: must include chunk field
        return `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, chunk: ${JSON.stringify(chunk.fileName)}, factory: (require) => {`;
      }
    },

    // Footer: closes factory function
    footer: 'return module.exports; } });',

    // Intro: inserted at top of factory (initializes module and exports)
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
};
