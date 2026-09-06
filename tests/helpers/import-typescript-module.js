const { bundleTypescriptModule } = require('./bundle-typescript-module');

async function importTypescriptModule(modulePath) {
  // Bundle local shared modules before importing a data URL, which has no
  // filesystem base for relative imports (e.g. the common email boundary).
  return bundleTypescriptModule(modulePath);
}

module.exports = { importTypescriptModule };
