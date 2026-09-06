import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
const client = await readFile(new URL('lib/client.js', root), 'utf8')

for (const file of ['lib/index.js', 'lib/client.js', 'lib/client.js.map', 'LICENSE', 'NOTICE']) {
  await access(new URL(file, root))
}

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('package.json must declare dsh.bundle.patch')
}
if (manifest.dsh?.client?.platform !== 'web') {
  throw new Error('package.json must declare a web client plugin')
}
if (!patch.includes('- insert:') || !patch.includes('id: chinese-talk') || !patch.includes(`name: ${manifest.name}`)) {
  throw new Error('cordis.patch.yml does not insert the chinese-talk row')
}
if (!client.includes(`id: \"${manifest.name}\"`) || !client.includes('window.__ModuleLoader__.load')) {
  throw new Error('lib/client.js is not a DeepSeek Harness client bundle')
}

console.log(`verified ${manifest.name}@${manifest.version}`)
