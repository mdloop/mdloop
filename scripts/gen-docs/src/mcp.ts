#!/usr/bin/env node
// MCP tool reference generator. AST-parses packages/mcp/src/server.ts
// *as it exists today* via ts-morph — no server boot, no execution, no
// `TOOLS`-const refactor required.
//
// Deliberately not a general zod-schema-to-JSON-Schema converter: it walks
// the fluent `z.xxx().yyy().describe(...)` call chain as *syntax* and reads
// off type/modifiers/description as source text. Running server.ts for real
// zod objects would drag in the whole @mdloop/app dependency graph just to
// read parameter shapes.

import { Project, SyntaxKind } from 'ts-morph';
import type {
  Node,
  CallExpression,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  StringLiteral,
  NoSubstitutionTemplateLiteral,
  ArrayLiteralExpression,
  SourceFile,
} from 'ts-morph';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, REFERENCE_DIR } from './paths.js';

const SERVER_TS = path.join(REPO_ROOT, 'packages/mcp/src/server.ts');
const OUT = path.join(REFERENCE_DIR, 'mcp-reference.md');

interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
  constraints: string[];
  description?: string | undefined;
  enumValues?: string[] | undefined;
}

interface ToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  params: FieldInfo[];
}

function isStringLike(node: Node): node is StringLiteral | NoSubstitutionTemplateLiteral {
  return (
    node.getKind() === SyntaxKind.StringLiteral ||
    node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

function stringLiteralValue(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (isStringLike(node)) return node.getLiteralText();
  return node.getText();
}

function walkChain(expr: Node | undefined): {
  base: string;
  calls: { method: string; args: Node[] }[];
} {
  const calls: { method: string; args: Node[] }[] = [];
  let cur: Node | undefined = expr;
  while (cur?.getKind() === SyntaxKind.CallExpression) {
    const call = cur as CallExpression;
    const callee = call.getExpression();
    if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = callee as PropertyAccessExpression;
      calls.push({ method: propAccess.getName(), args: call.getArguments() });
      cur = propAccess.getExpression();
    } else {
      break;
    }
  }
  calls.reverse();
  const base = cur ? cur.getText() : '(unknown)';
  return { base, calls };
}

function describeEnumValues(argNode: Node | undefined): string[] | undefined {
  if (argNode?.getKind() !== SyntaxKind.ArrayLiteralExpression) return undefined;
  const elements = (argNode as ArrayLiteralExpression).getElements();
  return elements.map((el) => stringLiteralValue(el)).filter((v): v is string => v !== undefined);
}

function findTopLevelConst(sourceFile: SourceFile, name: string): Node | undefined {
  for (const decl of sourceFile.getVariableDeclarations()) {
    if (decl.getName() === name) return decl.getInitializer();
  }
  return undefined;
}

function describeField(
  sourceFile: SourceFile,
  initializer: Node | undefined,
  depth = 0,
): FieldInfo {
  const { base, calls } = walkChain(initializer);

  let type = base;
  let optional = false;
  const constraints: string[] = [];
  let description: string | undefined;
  let enumValues: string[] | undefined;

  if (base !== 'z') {
    const resolved = depth === 0 ? findTopLevelConst(sourceFile, base) : undefined;
    if (resolved) {
      const inner = describeField(sourceFile, resolved, depth + 1);
      type = `${base} (${inner.type})`;
      enumValues = inner.enumValues;
      description ??= inner.description;
    } else {
      type = `${base} (unresolved reference)`;
    }
  }

  for (const call of calls) {
    switch (call.method) {
      case 'describe':
        description = stringLiteralValue(call.args[0]);
        break;
      case 'optional':
        optional = true;
        break;
      case 'string':
      case 'number':
      case 'boolean':
      case 'literal':
        if (base === 'z') type = call.method;
        break;
      case 'enum':
        if (base === 'z') {
          type = 'enum';
          enumValues = describeEnumValues(call.args[0]);
        }
        break;
      case 'union':
        if (base === 'z') type = 'union';
        break;
      case 'object':
        if (base === 'z') type = 'object';
        break;
      case 'int':
        constraints.push('integer');
        break;
      case 'positive':
        constraints.push('> 0');
        break;
      case 'min':
        constraints.push(`min ${call.args[0]?.getText() ?? '?'}`);
        break;
      case 'max':
        constraints.push(`max ${call.args[0]?.getText() ?? '?'}`);
        break;
      default:
        constraints.push(call.method);
    }
  }

  return { name: '', type, optional, constraints, description, enumValues };
}

function extractInputSchema(
  sourceFile: SourceFile,
  objLiteral: ObjectLiteralExpression,
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const prop of objLiteral.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const assignment = prop as PropertyAssignment;
    const name = assignment.getName();
    const initializer = assignment.getInitializer();
    fields.push({ ...describeField(sourceFile, initializer), name });
  }
  return fields;
}

function extractTools(): ToolInfo[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const sourceFile = project.addSourceFileAtPath(SERVER_TS);

  const tools: ToolInfo[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const propAccess = expr as PropertyAccessExpression;
    if (propAccess.getName() !== 'registerTool') return;
    if (propAccess.getExpression().getText() !== 'server') return;

    const args = call.getArguments();
    const nameArg = args[0];
    const configArg = args[1];
    if (!nameArg || configArg?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
      return;
    }
    const name = stringLiteralValue(nameArg);
    if (!name) return;
    let description: string | undefined;
    let title: string | undefined;
    let inputSchema: FieldInfo[] = [];
    for (const prop of (configArg as ObjectLiteralExpression).getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const assignment = prop as PropertyAssignment;
      const propName = assignment.getName();
      if (propName === 'description') description = stringLiteralValue(assignment.getInitializer());
      if (propName === 'title') title = stringLiteralValue(assignment.getInitializer());
      if (propName === 'inputSchema') {
        const init = assignment.getInitializer();
        if (init?.getKind() === SyntaxKind.ObjectLiteralExpression) {
          inputSchema = extractInputSchema(sourceFile, init as ObjectLiteralExpression);
        }
      }
    }
    tools.push({ name, title, description, params: inputSchema });
  });
  return tools;
}

function fieldTypeLabel(f: FieldInfo): string {
  let label = f.type;
  // `|` separates enum options in prose but also delimits markdown table
  // cells — a raw pipe silently shifts every column right (caught in the
  // spike against `list_documents`' `view` enum). Use "or" instead.
  if (f.enumValues) label = `enum: ${f.enumValues.map((v) => `\`${v}\``).join(' or ')}`;
  if (f.constraints.length > 0) label += ` (${f.constraints.join(', ')})`;
  return label.replace(/\|/g, '\\|');
}

export function toMarkdown(tools: ToolInfo[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: MCP tool reference');
  lines.push(
    'description: Generated by scripts/gen-docs/src/mcp.ts from packages/mcp/src/server.ts. Do not hand-edit.',
  );
  lines.push('---');
  lines.push('');
  lines.push(
    `> Generated from \`packages/mcp/src/server.ts\` by \`pnpm gen:mcp\`. ${String(tools.length)} tools found.`,
  );
  lines.push('');
  for (const tool of tools) {
    lines.push(`## \`${tool.name}\``);
    lines.push('');
    if (tool.description) lines.push(tool.description);
    lines.push('');
    if (tool.params.length === 0) {
      lines.push('No parameters.');
    } else {
      lines.push('| Parameter | Type | Required | Description |');
      lines.push('|---|---|---|---|');
      for (const p of tool.params) {
        const required = p.optional ? 'no' : 'yes';
        const desc = (p.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| \`${p.name}\` | ${fieldTypeLabel(p)} | ${required} | ${desc} |`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function generateMcpReference(): { tools: ToolInfo[]; markdown: string } {
  const tools = extractTools();
  const markdown = toMarkdown(tools);
  return { tools, markdown };
}

export function main(): void {
  const { tools, markdown } = generateMcpReference();
  mkdirSync(REFERENCE_DIR, { recursive: true });
  writeFileSync(OUT, markdown);
  console.log(
    `Extracted ${String(tools.length)} tools from ${path.relative(REPO_ROOT, SERVER_TS)}`,
  );
  for (const t of tools) {
    console.log(`  - ${t.name} (${String(t.params.length)} params)`);
  }
}

// Only run when executed directly (`pnpm gen:mcp`), not when imported by
// docs-check's diff comparison or the docs-parity test.
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main();
}
