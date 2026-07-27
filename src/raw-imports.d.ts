// Tells TypeScript that Vite's `?raw` imports of .md files resolve to a string.
// Without this, TS would error on `import content from './foo.md?raw'`.
declare module "*.md?raw" {
  const content: string;
  export default content;
}

// Vite resolves a bare `.css` import to a side-effecting style injection with no
// value. Declared here so importing a dependency's stylesheet (xterm's, for the
// terminal panel) type-checks.
declare module "*.css" {
  const content: string;
  export default content;
}
