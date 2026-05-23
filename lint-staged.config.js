module.exports = {
  "**/*.{ts,tsx}": () => "npm run ts",
  "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte}": "oxlint",
  // Filter out resources/ before passing to oxfmt — it panics on large markdown files
  "*": (files) => {
    const filtered = files.filter(
      (f) => !f.replace(/\\/g, "/").includes("/resources/"),
    );
    if (filtered.length === 0) return [];
    return `oxfmt --no-error-on-unmatched-pattern ${filtered.join(" ")}`;
  },
};
