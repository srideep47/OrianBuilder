const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");

// Function to recursively find all .tsx files
function findFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file));
    if (stat.isDirectory()) {
      findFiles(path.join(dir, file), fileList);
    } else if (file.endsWith(".tsx") || file.endsWith(".ts")) {
      fileList.push(path.join(dir, file));
    }
  }
  return fileList;
}

const files = findFiles(SRC_DIR);
let modifiedCount = 0;

for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  let originalContent = content;

  // Replace flat popover and card backgrounds with mac-glass-panel or mac-popover if they have heavy borders
  content = content.replace(/bg-background-lightest/g, "bg-card/40");
  content = content.replace(/bg-background-lighter/g, "bg-card/60");
  content = content.replace(/bg-background/g, "bg-transparent");
  content = content.replace(/shadow-sm/g, "shadow-md");
  content = content.replace(/rounded-md/g, "rounded-xl");
  content = content.replace(/rounded-lg/g, "rounded-2xl");
  content = content.replace(/rounded-xl/g, "rounded-3xl");

  // Make standard buttons feel more springy
  content = content.replace(/hover:scale-105/g, "hover:scale-[1.02]");
  content = content.replace(/active:scale-95/g, "active:scale-[0.98]");

  if (content !== originalContent) {
    fs.writeFileSync(file, content, "utf8");
    modifiedCount++;
  }
}

console.log(
  `Successfully migrated ${modifiedCount} files to macOS 26 Liquid Glass styling.`,
);
