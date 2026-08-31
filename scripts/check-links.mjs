import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const root = resolve('dist');
const workerRoutes = new Set(['/agents', '/agents/', '/install', '/install/']);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function targetPath(url, sourceFile) {
  const parsed = new URL(url, `https://ai-outfitter.com/${relative(root, sourceFile)}`);
  if (parsed.origin !== 'https://ai-outfitter.com') return;
  const pathname = decodeURIComponent(parsed.pathname);
  if (workerRoutes.has(pathname)) return root;
  const path = resolve(root, `.${pathname}`);
  if (pathname.endsWith('/')) {
    const index = resolve(path, 'index.html');
    if (existsSync(index)) return index;
    const flatHtml = `${path.replace(/\/$/, '')}.html`;
    if (existsSync(flatHtml)) return flatHtml;
    return index;
  }
  if (extname(pathname)) return path;
  if (existsSync(path)) return path;
  return resolve(path, 'index.html');
}

const failures = [];
const htmlFiles = (await walk(root)).filter((file) => file.endsWith('.html'));
for (const sourceFile of htmlFiles) {
  const html = await readFile(sourceFile, 'utf8');
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    const url = match[1];
    if (!url || url.startsWith('#') || url.startsWith('data:')) continue;
    const target = targetPath(url, sourceFile);
    if (!target) continue;
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      failures.push(`${relative(root, sourceFile)} -> ${url} escapes dist`);
      continue;
    }
    if (!existsSync(target)) failures.push(`${relative(root, sourceFile)} -> ${url}`);
  }
}

assert.deepEqual(failures, [], `Broken generated links:\n${failures.join('\n')}`);
console.log(`Validated internal links and assets across ${htmlFiles.length} HTML pages.`);
