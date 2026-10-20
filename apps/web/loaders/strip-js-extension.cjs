// Workspace packages are NodeNext ESM and import their own TypeScript sources as './x.js'.
// Turbopack does not map those specifiers back to './x.ts', so this loader drops the '.js'
// from relative specifiers and lets normal extension resolution find the .ts file.
// Applied only to packages/*/src (see next.config.ts).
const RELATIVE_JS = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+?)\.js\2/g;

module.exports = function stripJsExtension(source) {
  return source.replace(RELATIVE_JS, '$1$2$3$2');
};
