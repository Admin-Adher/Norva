const fs = require('node:fs');
const { transform } = require('esbuild');

async function importTypescriptModule(modulePath) {
  const source = fs.readFileSync(modulePath, 'utf8');
  const { code } = await transform(source, {
    format: 'esm',
    loader: 'ts',
    sourcefile: modulePath,
    target: 'node18',
  });
  const encoded = Buffer.from(code).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

module.exports = { importTypescriptModule };
