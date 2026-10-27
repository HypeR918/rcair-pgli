import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const base = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', base));

// Запускает исходные модули с подменой только внешних границ: БД, SMTP, HTTP.
export async function loadIsolated(file, mocks = {}) {
  const modules = new Map();
  const resolvedMocks = new Map(Object.entries(mocks).map(([name, values]) => [
    name.startsWith('.') ? new URL(name, base).href : name, values,
  ]));
  async function load(specifier, parent = base.href) {
    const id = specifier.startsWith('.') ? new URL(specifier, parent).href : specifier;
    if (modules.has(id)) return modules.get(id);
    if (resolvedMocks.has(id) || !id.startsWith(base.href)) {
      let values = resolvedMocks.get(id);
      if (!values) values = await import(id.startsWith('node:') || id.startsWith('file:')
        ? id : pathToFileURL(require.resolve(id)).href);
      const module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      });
      modules.set(id, module);
      return module;
    }
    const source = await readFile(new URL(id), 'utf8');
    const module = new vm.SourceTextModule(source, {
      identifier: id,
      initializeImportMeta(meta) { meta.url = id; },
      async importModuleDynamically(spec, parentModule) {
        const child = await load(spec, parentModule.identifier);
        if (child.status === 'unlinked') await child.link(link);
        if (child.status === 'linked') await child.evaluate();
        return child;
      },
    });
    modules.set(id, module);
    return module;
  }
  const link = (specifier, parent) => load(specifier, parent.identifier);
  const root = await load(new URL(file, base).href);
  await root.link(link);
  await root.evaluate();
  return root.namespace;
}

export const noop = async () => {};
