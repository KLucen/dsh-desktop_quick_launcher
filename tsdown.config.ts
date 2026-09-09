import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  format: ['esm'],
  target: 'node22',
  external: [
    'schemastery',
    'react',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-system-prompt',
  ],
  clean: true,
  outDir: 'lib',
  dts: true,
})
