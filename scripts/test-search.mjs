import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve('dist');
const contentTypes = new Map([
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = resolve(join(root, pathname));
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error('Not a file');

    response.setHeader('content-type', contentTypes.get(extname(file)) ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const basePath = `http://127.0.0.1:${address.port}/pagefind/`;
  const pagefind = await import('../dist/pagefind/pagefind.js');
  await pagefind.options({ basePath });

  const search = await pagefind.search('move the control point outward');
  const results = await Promise.all(
    search.results.slice(0, 3).map(async (result) => {
      const data = await result.data();
      return { title: data.meta.title, url: new URL(data.url).pathname };
    }),
  );

  assert.deepEqual(results[0], {
    title: 'Move the control point outward',
    url: '/docs/adoption-ramp/',
  });

  const agentOperator = await readFile('dist/docs/agent-operator/index.html', 'utf8');
  assert.match(agentOperator, /alpha and actively used/i);
  assert.match(agentOperator, /Synced from/);
  assert.doesNotMatch(agentOperator, /design stage/i);

  console.log('Search and canonical repository documentation regressions pass.');
} finally {
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}
