import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

async function htmlFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = resolve(path, entry.name);
      // These are copied repository files, not Astro outputs rendered through a page shell.
      if (entry.isDirectory() && child === resolve('dist/repository-assets')) return [];
      if (entry.isDirectory()) return htmlFiles(child);
      return extname(entry.name) === '.html' ? [child] : [];
    }),
  );
  return nested.flat();
}

const builtPages = await htmlFiles('dist');
assert.ok(builtPages.length > 0, 'The static build must contain HTML pages');

for (const path of builtPages) {
  const html = await readFile(path, 'utf8');
  assert.equal(
    (html.match(/<script\b[^>]*\bdata-posthog-analytics\b/g) ?? []).length,
    1,
    `${path} must contain exactly one PostHog analytics script`,
  );
}

const pages = new Map([
  ['Starlight', 'dist/docs/index.html'],
  ['workflow', 'dist/workflows/index.html'],
]);

for (const [pageType, path] of pages) {
  const html = await readFile(path, 'utf8');
  const dom = new JSDOM(html);
  const analyticsScripts = dom.window.document.querySelectorAll(
    'script[data-posthog-analytics]',
  );

  assert.equal(
    analyticsScripts.length,
    1,
    `${pageType} page must contain exactly one PostHog initialization`,
  );

  const script = analyticsScripts[0].textContent;
  assert.equal((script.match(/posthog\.init\(/g) ?? []).length, 1);
  assert.match(script, /phc_v9FGDjtEC7h9UvLxHdJKaHFtFfMN7UZwpJ2weRTFoqvz/);
  assert.match(script, /api_host:\s*['"]https:\/\/us\.i\.posthog\.com['"]/);
  assert.match(script, /person_profiles:\s*['"]never['"]/);
  assert.match(script, /respect_dnt:\s*true/);
  assert.match(script, /autocapture:\s*false/);
  assert.match(script, /capture_pageview:\s*false/);
  assert.match(script, /mask_personal_data_properties:\s*true/);
  assert.match(script, /posthog\.register\(\{\s*['"]\$geoip_disable['"]:\s*true\s*}\)/);
  assert.match(script, /posthog\.capture\(['"]\$pageview['"]\)/);
  assert.doesNotMatch(script, /posthog\.identify\s*\(/);
  assert.match(script, /disable_session_recording:\s*true/);
  assert.ok(
    script.indexOf("posthog.register({ '$geoip_disable': true })") <
      script.indexOf("posthog.capture('$pageview')"),
    'GeoIP must be disabled before the pageview is captured',
  );
}

console.log(
  `PostHog analytics is present once on all ${builtPages.length} HTML pages and configured once in each page shell.`,
);
