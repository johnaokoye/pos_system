#!/usr/bin/env node
// Checks the rules public/js relies on, which the browser won't flag itself:
//  - every App member name is unique, within a file and across files (a repeat
//    silently replaces the earlier one)
//  - core.js declares App, every other file is one Object.assign(App, {...}),
//    and no file outside core.js uses get/set (Object.assign would freeze them)
//  - index.html loads every file in public/js exactly once, core first, boot last
// Usage: node scripts/check-frontend.js [public dir]. Exits 1 on any problem.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

function checkFrontend(publicDir = path.join(__dirname, '..', 'public')) {
  const problems = [];
  const jsDir = path.join(publicDir, 'js');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const loaded = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map(m => m[1]);
  const onDisk = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

  for (const f of onDisk) if (!loaded.includes(f)) problems.push(`${f}: no <script> tag in index.html`);
  for (const f of loaded) if (!onDisk.includes(f)) problems.push(`index.html loads /js/${f}, which doesn't exist`);
  for (const f of new Set(loaded)) if (loaded.indexOf(f) !== loaded.lastIndexOf(f)) problems.push(`index.html loads /js/${f} twice`);
  if (loaded[0] !== 'core.js') problems.push('index.html must load core.js first');
  if (loaded[loaded.length - 1] !== 'boot.js') problems.push('index.html must load boot.js last');

  const seen = new Map();
  let members = 0;
  for (const f of onDisk.filter(x => x !== 'boot.js')) {
    let ast;
    try {
      ast = acorn.parse(fs.readFileSync(path.join(jsDir, f), 'utf8'), { ecmaVersion: 'latest', locations: true });
    } catch (e) {
      problems.push(`${f}: syntax error: ${e.message}`);
      continue;
    }
    const stmt = ast.body[0];
    const isCore = f === 'core.js';
    const obj = isCore
      ? stmt?.type === 'VariableDeclaration' && stmt.declarations[0].id.name === 'App' && stmt.declarations[0].init
      : stmt?.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression'
        && stmt.expression.callee.object?.name === 'Object' && stmt.expression.callee.property?.name === 'assign'
        && stmt.expression.arguments[0]?.name === 'App' && stmt.expression.arguments[1];
    if (ast.body.length !== 1 || obj?.type !== 'ObjectExpression') {
      problems.push(`${f}: must contain only ${isCore ? 'const App = {...}' : 'Object.assign(App, {...})'}`);
      continue;
    }
    for (const p of obj.properties) {
      const where = `${f}:${p.loc.start.line}`;
      if (p.type !== 'Property' || p.computed) { problems.push(`${where}: spread and computed members aren't checkable`); continue; }
      const name = p.key.name ?? String(p.key.value);
      members++;
      if ((p.kind === 'get' || p.kind === 'set') && !isCore) problems.push(`${where}: ${p.kind} ${name} only works in core.js`);
      if (seen.has(name)) problems.push(`${where}: ${name} already defined at ${seen.get(name)}`);
      else seen.set(name, where);
    }
  }
  return { problems, members, files: onDisk.length };
}

if (require.main === module) {
  const { problems, members, files } = checkFrontend(process.argv[2]);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`OK: ${members} App members in ${files} files`);
}

module.exports = { checkFrontend };
