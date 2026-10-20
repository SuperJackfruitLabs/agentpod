// Run after `astro build`: the suite frame must be in the built HTML, and the site's own
// masthead must be gone.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const failures = [];
for (const tag of ['<sjl-suite-bar', '<sjl-product-header', '<sjl-claims', '<sjl-street']) {
  if (!html.includes(tag)) failures.push(`missing ${tag}`);
}
if (/<header class/.test(html)) failures.push('the old masthead (<header class…) is still there');
if (html.includes('x-sjl-preview')) failures.push('x-sjl-preview leaked into the build');
if (failures.length) {
  console.error('check-frame: FAIL\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('check-frame: PASS');
