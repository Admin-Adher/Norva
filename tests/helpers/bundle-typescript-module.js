const { build } = require('esbuild');

// importTypescriptModule transforms one file and imports it as a data URL, which
// works only while the module has no relative imports: a `./x.ts` cannot resolve
// against a data: URL. This bundles the graph first, for shared modules that are
// split across files.
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
