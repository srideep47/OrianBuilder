const fs = require("fs");
const path = require("path");
const { globSync } = require("glob");

const srcDir = path.join(__dirname, "..", "src");

const replacements = [
  { regex: /purple-50/g, replacement: "blue-50" },
  { regex: /purple-100/g, replacement: "blue-100" },
  { regex: /purple-200/g, replacement: "blue-200" },
  { regex: /purple-300/g, replacement: "blue-300" },
  { regex: /purple-400/g, replacement: "blue-400" },
  { regex: /purple-500/g, replacement: "blue-500" },
  { regex: /purple-600/g, replacement: "blue-600" },
  { regex: /purple-700/g, replacement: "blue-700" },
  { regex: /purple-800/g, replacement: "blue-800" },
  { regex: /purple-900/g, replacement: "blue-900" },
  { regex: /purple-950/g, replacement: "blue-950" },
  { regex: /violet-50/g, replacement: "indigo-50" },
  { regex: /violet-100/g, replacement: "indigo-100" },
  { regex: /violet-200/g, replacement: "indigo-200" },
  { regex: /violet-300/g, replacement: "indigo-300" },
  { regex: /violet-400/g, replacement: "indigo-400" },
  { regex: /violet-500/g, replacement: "indigo-500" },
  { regex: /violet-600/g, replacement: "indigo-600" },
  { regex: /violet-700/g, replacement: "indigo-700" },
  { regex: /violet-800/g, replacement: "indigo-800" },
  { regex: /violet-900/g, replacement: "indigo-900" },
  { regex: /violet-950/g, replacement: "indigo-950" },
];

const files = globSync(`${srcDir}/**/*.{ts,tsx,css}`.replace(/\\/g, "/"));

let modifiedFiles = 0;

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  let newContent = content;

  for (const rep of replacements) {
    newContent = newContent.replace(rep.regex, rep.replacement);
  }

  // Specific literal color replacements
  newContent = newContent.replace(/"purple"/g, '"blue"');
  newContent = newContent.replace(/'purple'/g, "'blue'");
  newContent = newContent.replace(
    /accentColor="purple"/g,
    'accentColor="blue"',
  );

  if (content !== newContent) {
    fs.writeFileSync(file, newContent, "utf-8");
    modifiedFiles++;
    console.log(`Modified: ${file}`);
  }
}

console.log(`Successfully updated colors in ${modifiedFiles} files.`);
