import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PACKAGE_NAME = 'dsh-chinese-talk'
const CSS_PREFIX = '\0dsh-chinese-talk-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
])

function cssModulePlugin() {
  return {
    name: 'dsh-chinese-talk-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      return CSS_PREFIX + (importer === undefined ? source : resolve(dirname(importer), source)) + CSS_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const filename = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(filename)
      const source = await readFile(filename)
      const result = transform({
        filename,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(result.exports ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([local, value]) => [local, value.name]),
      )
      const css = result.code.toString()
      const styleId = `${PACKAGE_NAME}/VoiceSidebar.module.css`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const styleId = ${JSON.stringify(styleId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(styleId) + ']') === null) {",
        "  const style = document.createElement('style');",
        `  style.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
        '  style.dataset.pluginCss = styleId;',
        '  style.textContent = css;',
        '  document.head.appendChild(style);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: { index: 'dsh-plugin/src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'dsh-plugin/src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssModulePlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
