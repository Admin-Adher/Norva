const { build } = require('esbuild');

// Shared implementation for data-URL test imports, including the legacy
// importTypescriptModule entry point. Bundle local dependencies first because
// a `./x.ts` cannot resolve against a data: URL.
//
// Deno specifiers (npm:, jsr:, https:) are left external. In these modules they
// only ever carry types, so the TypeScript erasure removes them entirely and
// nothing remains to resolve at runtime.
async function bundleTypescriptModule(modulePath) {
  const result = await build({
    entryPoints: [modulePath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'node18',
    external: ['npm:*', 'jsr:*', 'https://*', 'node:*'],
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

module.exports = { bundleTypescriptModule };
