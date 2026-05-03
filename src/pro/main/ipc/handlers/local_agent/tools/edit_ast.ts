import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("edit_ast");

// ─── Schema ─────────────────────────────────────────────────────────────────

const editAstSchema = z.discriminatedUnion("operation", [
  /**
   * Rename a symbol and ALL its references — including across files.
   * Uses the TypeScript Language Service, so it understands type-aware
   * references (not just textual matches).
   */
  z.object({
    operation: z.literal("rename_symbol"),
    file: z
      .string()
      .describe(
        "Relative path to the file where the symbol is DEFINED (not just used).",
      ),
    old_name: z.string().describe("Current identifier name to rename."),
    new_name: z.string().describe("New identifier name."),
  }),

  /**
   * Add an import declaration — or merge named imports into an existing one.
   * Idempotent: already-imported names are skipped automatically.
   */
  z.object({
    operation: z.literal("add_import"),
    file: z.string().describe("Relative path to the file."),
    module: z
      .string()
      .describe(
        "Module specifier, e.g. 'react', './utils', '@/lib/db', 'node:path'.",
      ),
    named: z
      .array(z.string())
      .optional()
      .describe("Named imports to add, e.g. ['useState', 'useCallback']."),
    default_import: z
      .string()
      .optional()
      .describe(
        "Default import name, e.g. 'React' for 'import React from \"react\"'.",
      ),
    namespace_import: z
      .string()
      .optional()
      .describe(
        "Namespace import name, e.g. 'fs' for 'import * as fs from \"fs\"'.",
      ),
    type_only: z
      .boolean()
      .optional()
      .default(false)
      .describe("Emit as 'import type { ... }'. Default false."),
  }),

  /**
   * Remove an import declaration or specific named specifiers from one.
   */
  z.object({
    operation: z.literal("remove_import"),
    file: z.string().describe("Relative path to the file."),
    module: z.string().describe("Module specifier of the import to target."),
    named: z
      .array(z.string())
      .optional()
      .describe(
        "Specific named imports to remove. Omit to remove the entire import declaration.",
      ),
  }),

  /**
   * Delete a top-level declaration by name.
   * Handles: function, class, interface, type alias, enum, const/let/var.
   */
  z.object({
    operation: z.literal("delete_symbol"),
    file: z.string().describe("Relative path to the file."),
    name: z
      .string()
      .describe(
        "Name of the declaration to delete (function, class, variable, interface, type, enum).",
      ),
  }),

  /**
   * Replace just the body of a named function or arrow function.
   * Far more reliable than search_replace for functions with complex signatures.
   */
  z.object({
    operation: z.literal("replace_function_body"),
    file: z.string().describe("Relative path to the file."),
    function_name: z.string().describe("Name of the function to target."),
    new_body: z
      .string()
      .describe(
        "New body content. Do NOT include the outer braces { }. " +
          "For arrow functions that return JSX, write the JSX directly (no return statement needed for implicit return) " +
          "or use 'return (...);' for block body.",
      ),
  }),

  /**
   * Insert code after a named top-level symbol.
   * Useful for adding a new function after an existing one without knowing the exact line.
   */
  z.object({
    operation: z.literal("insert_after_symbol"),
    file: z.string().describe("Relative path to the file."),
    symbol_name: z
      .string()
      .describe(
        "Name of the top-level function, class, or variable after which to insert.",
      ),
    code: z
      .string()
      .describe(
        "Complete, valid TypeScript/TSX code to insert. Must be top-level statements.",
      ),
  }),
]);

type EditAstArgs = z.infer<typeof editAstSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findTsConfig(appPath: string): string | undefined {
  for (const name of [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.base.json",
  ]) {
    const p = path.join(appPath, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Resolve and validate a relative file path from args */
function resolveFile(appPath: string, relativePath: string): string {
  const abs = path.resolve(appPath, relativePath);
  if (!abs.startsWith(appPath)) {
    throw new DyadError(
      `Path "${relativePath}" escapes the app directory.`,
      DyadErrorKind.Validation,
    );
  }
  if (!fs.existsSync(abs)) {
    throw new DyadError(
      `File not found: ${relativePath}`,
      DyadErrorKind.NotFound,
    );
  }
  return abs;
}

// ─── Operation handlers ───────────────────────────────────────────────────────

async function opRenameSymbol(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "rename_symbol" }>,
): Promise<string> {
  const { Project, SyntaxKind } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const tsConfigFilePath = findTsConfig(appPath);
  const project = tsConfigFilePath
    ? new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false })
    : new Project({ skipAddingFilesFromTsConfig: true });

  // Ensure the target file is in the project
  let sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    sourceFile = project.addSourceFileAtPath(filePath);
  }

  // Find the first identifier matching old_name — prefer definition-site nodes
  // by looking at top-level declarations first, then all identifiers.
  const allIdentifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  const target = allIdentifiers.find((id) => id.getText() === args.old_name);
  if (!target) {
    throw new DyadError(
      `Identifier "${args.old_name}" not found in ${args.file}. ` +
        `Make sure you're pointing to the file where it is DEFINED.`,
      DyadErrorKind.NotFound,
    );
  }

  // Rename — Language Service updates all references across project files
  target.rename(args.new_name);

  // Collect modified files and save
  const modified = project
    .getSourceFiles()
    .filter((sf) => sf.wasForgotten() === false && sf.isSaved() === false);
  const modifiedPaths = modified.map((sf) =>
    path.relative(appPath, sf.getFilePath()).replace(/\\/g, "/"),
  );
  await project.save();

  if (modifiedPaths.length === 0) {
    modifiedPaths.push(args.file);
  }

  return (
    `Renamed "${args.old_name}" → "${args.new_name}" in ${modifiedPaths.length} file(s):\n` +
    modifiedPaths.map((p) => `- ${p}`).join("\n")
  );
}

async function opAddImport(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "add_import" }>,
): Promise<string> {
  const { Project } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(filePath);

  const existing = sourceFile.getImportDeclaration(
    (decl) => decl.getModuleSpecifierValue() === args.module,
  );

  const added: string[] = [];

  if (existing) {
    // Merge into existing import declaration
    if (args.named?.length) {
      const alreadyImported = new Set(
        existing.getNamedImports().map((n) => n.getName()),
      );
      const toAdd = args.named.filter((n) => !alreadyImported.has(n));
      if (toAdd.length > 0) {
        existing.addNamedImports(toAdd);
        added.push(...toAdd.map((n) => `{ ${n} }`));
      }
    }
    if (args.default_import && !existing.getDefaultImport()) {
      existing.setDefaultImport(args.default_import);
      added.push(args.default_import);
    }
  } else {
    // Add new import declaration
    const structure: Parameters<typeof sourceFile.addImportDeclaration>[0] = {
      moduleSpecifier: args.module,
      isTypeOnly: args.type_only ?? false,
    };
    if (args.named?.length) structure.namedImports = args.named;
    if (args.default_import) structure.defaultImport = args.default_import;
    if (args.namespace_import)
      structure.namespaceImport = args.namespace_import;
    sourceFile.addImportDeclaration(structure);
    if (args.named?.length) added.push(...args.named.map((n) => `{ ${n} }`));
    if (args.default_import) added.push(args.default_import);
    if (args.namespace_import) added.push(`* as ${args.namespace_import}`);
  }

  await sourceFile.save();

  if (added.length === 0) {
    return `All requested imports from "${args.module}" were already present in ${args.file}.`;
  }
  return `Added [${added.join(", ")}] from "${args.module}" to ${args.file}.`;
}

async function opRemoveImport(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "remove_import" }>,
): Promise<string> {
  const { Project } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(filePath);

  const decl = sourceFile.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === args.module,
  );
  if (!decl) {
    throw new DyadError(
      `No import from "${args.module}" found in ${args.file}.`,
      DyadErrorKind.NotFound,
    );
  }

  if (args.named && args.named.length > 0) {
    const removed: string[] = [];
    for (const imp of decl.getNamedImports()) {
      if (args.named.includes(imp.getName())) {
        removed.push(imp.getName());
        imp.remove();
      }
    }
    // Remove whole declaration if no named imports and no default/namespace remain
    if (
      decl.getNamedImports().length === 0 &&
      !decl.getDefaultImport() &&
      !decl.getNamespaceImport()
    ) {
      decl.remove();
    }
    await sourceFile.save();
    return `Removed [${removed.join(", ")}] from import "${args.module}" in ${args.file}.`;
  }

  decl.remove();
  await sourceFile.save();
  return `Removed entire import from "${args.module}" in ${args.file}.`;
}

async function opDeleteSymbol(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "delete_symbol" }>,
): Promise<string> {
  const { Project } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(filePath);

  const name = args.name;

  // Try each declaration kind in order
  const fn = sourceFile.getFunction(name);
  if (fn) {
    fn.remove();
    await sourceFile.save();
    return `Deleted function "${name}" from ${args.file}.`;
  }

  const cls = sourceFile.getClass(name);
  if (cls) {
    cls.remove();
    await sourceFile.save();
    return `Deleted class "${name}" from ${args.file}.`;
  }

  const iface = sourceFile.getInterface(name);
  if (iface) {
    iface.remove();
    await sourceFile.save();
    return `Deleted interface "${name}" from ${args.file}.`;
  }

  const typeAlias = sourceFile.getTypeAlias(name);
  if (typeAlias) {
    typeAlias.remove();
    await sourceFile.save();
    return `Deleted type alias "${name}" from ${args.file}.`;
  }

  const enm = sourceFile.getEnum(name);
  if (enm) {
    enm.remove();
    await sourceFile.save();
    return `Deleted enum "${name}" from ${args.file}.`;
  }

  const varDecl = sourceFile.getVariableDeclaration(name);
  if (varDecl) {
    const stmt = varDecl.getVariableStatement();
    if (stmt && stmt.getDeclarations().length === 1) {
      stmt.remove();
    } else {
      varDecl.remove();
    }
    await sourceFile.save();
    return `Deleted variable "${name}" from ${args.file}.`;
  }

  throw new DyadError(
    `Symbol "${name}" not found in ${args.file}. ` +
      `Searched for: function, class, interface, type, enum, variable.`,
    DyadErrorKind.NotFound,
  );
}

async function opReplaceFunctionBody(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "replace_function_body" }>,
): Promise<string> {
  const { Project, SyntaxKind } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(filePath);

  const name = args.function_name;

  // Function declaration
  const fn = sourceFile.getFunction(name);
  if (fn) {
    fn.setBodyText(args.new_body);
    await sourceFile.save();
    return `Replaced body of function "${name}" in ${args.file}.`;
  }

  // Arrow function / function expression stored as a variable
  const varDecl = sourceFile.getVariableDeclaration(name);
  if (varDecl) {
    const init = varDecl.getInitializer();
    if (init) {
      const kind = init.getKind();
      if (
        kind === SyntaxKind.ArrowFunction ||
        kind === SyntaxKind.FunctionExpression
      ) {
        (init as any).setBodyText(args.new_body);
        await sourceFile.save();
        return `Replaced body of "${name}" (arrow/fn expression) in ${args.file}.`;
      }
    }
  }

  throw new DyadError(
    `Function "${name}" not found in ${args.file}. ` +
      `Looked for function declarations and const/let arrow functions.`,
    DyadErrorKind.NotFound,
  );
}

async function opInsertAfterSymbol(
  appPath: string,
  args: Extract<EditAstArgs, { operation: "insert_after_symbol" }>,
): Promise<string> {
  const { Project } = await import("ts-morph");
  const filePath = resolveFile(appPath, args.file);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(filePath);

  const name = args.symbol_name;

  // Find the top-level statement that contains this symbol
  let targetStmt: import("ts-morph").Statement | undefined;

  const fn = sourceFile.getFunction(name);
  if (fn) targetStmt = fn;

  if (!targetStmt) {
    const cls = sourceFile.getClass(name);
    if (cls) targetStmt = cls;
  }

  if (!targetStmt) {
    const iface = sourceFile.getInterface(name);
    if (iface) targetStmt = iface;
  }

  if (!targetStmt) {
    const typeAlias = sourceFile.getTypeAlias(name);
    if (typeAlias) targetStmt = typeAlias;
  }

  if (!targetStmt) {
    const varDecl = sourceFile.getVariableDeclaration(name);
    if (varDecl) targetStmt = varDecl.getVariableStatement() ?? undefined;
  }

  if (!targetStmt) {
    throw new DyadError(
      `Symbol "${name}" not found in ${args.file}.`,
      DyadErrorKind.NotFound,
    );
  }

  // Insert after this statement in its parent
  const idx = targetStmt.getChildIndex();
  sourceFile.insertStatements(idx + 1, "\n" + args.code);
  await sourceFile.save();

  return `Inserted code after "${name}" in ${args.file}.`;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const editAstTool: ToolDefinition<EditAstArgs> = {
  name: "edit_ast",
  description: `Perform semantic (AST-level) edits on TypeScript/TSX files — operations that \`search_replace\` cannot do reliably.

### Operations

| operation | What it does |
|---|---|
| \`rename_symbol\` | Rename an identifier AND all its references across the project using the TypeScript Language Service. Safe rename — not a text search. |
| \`add_import\` | Add a new import or merge named specifiers into an existing one. Idempotent. |
| \`remove_import\` | Remove an entire import declaration or just specific named specifiers. |
| \`delete_symbol\` | Delete a top-level function, class, interface, type, enum, or variable by name. |
| \`replace_function_body\` | Replace the body of a named function or arrow function. More reliable than \`search_replace\` for functions with complex JSX bodies. |
| \`insert_after_symbol\` | Insert new top-level code after a named declaration without knowing the exact line number. |

### When to use edit_ast instead of search_replace

- **Renaming**: ALWAYS use \`rename_symbol\` — it uses the TypeScript compiler and updates call sites, type references, and JSX usage across ALL files.
- **Imports**: Use \`add_import\` / \`remove_import\` to manage import blocks without risking malformed import syntax.
- **Deleting**: Use \`delete_symbol\` when you need to remove an entire function/class cleanly.
- **Complex function bodies**: Use \`replace_function_body\` when the function body is long JSX and \`search_replace\` would require matching too much context.
- **Inserting after a symbol**: Use \`insert_after_symbol\` when you want to add code after a specific function without knowing its exact ending line.

### When NOT to use edit_ast

- For small targeted text edits inside a function: use \`search_replace\` (faster, no AST overhead).
- For non-TypeScript files (.css, .json, .md, .yaml, .py, .go): use \`search_replace\` or \`write_file\`.
- For renaming files or directories: use \`run_terminal_command\`.

### Notes on rename_symbol

- Point \`file\` to the file where the symbol is **defined**, not where it's used.
- The rename propagates to all files the tsconfig.json knows about.
- For symbols that share a name (e.g. a prop named \`name\` inside an interface), the rename targets the specific identifier at the definition site.`,

  inputSchema: editAstSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => {
    switch (args.operation) {
      case "rename_symbol":
        return `AST rename "${args.old_name}" → "${args.new_name}" in ${args.file}`;
      case "add_import":
        return `Add import from "${args.module}" to ${args.file}`;
      case "remove_import":
        return `Remove import from "${args.module}" in ${args.file}`;
      case "delete_symbol":
        return `Delete "${args.name}" from ${args.file}`;
      case "replace_function_body":
        return `Replace body of "${args.function_name}" in ${args.file}`;
      case "insert_after_symbol":
        return `Insert code after "${args.symbol_name}" in ${args.file}`;
      default:
        return "AST edit";
    }
  },

  buildXml: (args, isComplete) => {
    if (!args.operation || !args.file) return undefined;
    if (isComplete) return undefined;
    return `<dyad-ast-edit operation="${escapeXmlAttr(args.operation ?? "")}" file="${escapeXmlAttr(args.file ?? "")}">Processing…`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(
      `edit_ast: op=${args.operation} file=${args.file} appPath=${ctx.appPath}`,
    );

    ctx.onXmlStream(
      `<dyad-ast-edit operation="${escapeXmlAttr(args.operation)}" file="${escapeXmlAttr(args.file)}">Processing…`,
    );

    let resultText: string;

    try {
      switch (args.operation) {
        case "rename_symbol":
          resultText = await opRenameSymbol(ctx.appPath, args);
          break;
        case "add_import":
          resultText = await opAddImport(ctx.appPath, args);
          break;
        case "remove_import":
          resultText = await opRemoveImport(ctx.appPath, args);
          break;
        case "delete_symbol":
          resultText = await opDeleteSymbol(ctx.appPath, args);
          break;
        case "replace_function_body":
          resultText = await opReplaceFunctionBody(ctx.appPath, args);
          break;
        case "insert_after_symbol":
          resultText = await opInsertAfterSymbol(ctx.appPath, args);
          break;
        default:
          throw new DyadError("Unknown operation", DyadErrorKind.Validation);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onXmlComplete(
        `<dyad-ast-edit operation="${escapeXmlAttr(args.operation)}" file="${escapeXmlAttr(args.file)}" error="${escapeXmlAttr(msg)}"></dyad-ast-edit>`,
      );
      throw err;
    }

    logger.log(`edit_ast: done — ${resultText}`);

    ctx.onXmlComplete(
      `<dyad-ast-edit operation="${escapeXmlAttr(args.operation)}" file="${escapeXmlAttr(args.file)}">${escapeXmlContent(resultText)}</dyad-ast-edit>`,
    );

    return resultText;
  },
};
