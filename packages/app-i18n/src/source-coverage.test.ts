import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// This package is shared between hosts that ship different applications (the web apps in one
// repository, the desktop app in another). The shared library roots must exist wherever this file
// runs; the application roots are scanned when present, so one file guards every host's interface
// without a fork.
const REQUIRED_SOURCE_ROOTS = ['packages/app-ui/src', 'packages/app-client/src'] as const;
const APPLICATION_SOURCE_ROOTS = readdirSync(resolve(REPO_ROOT, 'apps'), {
  withFileTypes: true,
})
  .filter(entry => entry.isDirectory())
  .map(entry => `apps/${entry.name}`)
  .filter(root => {
    const packageJson = resolve(REPO_ROOT, root, 'package.json');
    return (
      existsSync(resolve(REPO_ROOT, root, 'src')) &&
      existsSync(packageJson) &&
      readFileSync(packageJson, 'utf8').includes('"@prismical/app-i18n"')
    );
  })
  .map(root => `${root}/src`);
const SOURCE_ROOTS = [
  ...REQUIRED_SOURCE_ROOTS,
  ...APPLICATION_SOURCE_ROOTS.filter(root => existsSync(resolve(REPO_ROOT, root))),
];

const VISIBLE_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'placeholder',
  'title',
]);
const NATIVE_VISIBLE_PROPERTIES = new Set([
  'body',
  'buttons',
  'buttonLabel',
  'detail',
  'label',
  'message',
  'subtitle',
  'title',
]);
const NATIVE_UI_PATHS = [
  'apps/desktop/src/main/domains/notify/',
  'apps/desktop/src/main/domains/tray/',
  'apps/desktop/src/main/domains/updater/',
  'apps/desktop/src/main/entry.ts',
  'apps/desktop/src/main/infra/electron/application-menu.ts',
] as const;

interface Finding {
  readonly file: string;
  readonly kind: string;
  readonly line: number;
  readonly value: string;
}

const REVIEWED_VISIBLE_LITERALS = new Map<string, string>([
  ['Prismical', 'product name'],
  ['OpenAI', 'provider name'],
  ['Anthropic', 'provider name'],
  ['Groq', 'provider name'],
  ['OpenRouter', 'provider name'],
  ['Ollama', 'provider name'],
  ['Google Gemini', 'provider name'],
  ['Vercel', 'provider name'],
  ['Cloudflare', 'provider name'],
  ['Cerebras', 'provider name'],
  ['Apple', 'provider name'],
  ['Apple Calendar', 'provider name'],
  ['Google Calendar', 'provider name'],
  ['Prismical-Signature', 'protocol header name'],
  ['whsec_••••••••••••', 'masked protocol secret example'],
  ['`${t}.${body}`', 'protocol signature example'],
  ['https://mcp.example.com/mcp…', 'protocol URL example'],
  ['{"X-Api-Key": "…"}', 'protocol header example'],
  ['Esc', 'keyboard key'],
]);

function listSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!['.ts', '.tsx'].includes(extname(entry.name))) return [];
    if (/\.(?:spec|test|stories)\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.endsWith('.d.ts') || entry.name === 'routeTree.gen.ts') return [];
    // Social-card pixels are rendered by image routes, not by the application interface.
    if (entry.name === 'opengraph-image.tsx') return [];
    return [path];
  });
}

function normalizeLiteral(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function staticString(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteralLike(node)) return normalizeLiteral(node.text);
  if (ts.isJsxExpression(node)) return staticString(node.expression);
  return undefined;
}

function visibleExpressionStrings(node: ts.Expression | undefined): string[] {
  if (node === undefined) return [];
  if (ts.isStringLiteralLike(node)) return [normalizeLiteral(node.text)];
  if (ts.isParenthesizedExpression(node)) return visibleExpressionStrings(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [
      ...visibleExpressionStrings(node.whenTrue),
      ...visibleExpressionStrings(node.whenFalse),
    ];
  }
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
      node.operatorToken.kind
    )
  ) {
    return [...visibleExpressionStrings(node.left), ...visibleExpressionStrings(node.right)];
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].map(
      normalizeLiteral
    );
  }
  return [];
}

function isVisibleLiteral(value: string | undefined): value is string {
  return value !== undefined && !/^&[a-z]+;$/i.test(value) && /\p{L}{2}/u.test(value);
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}

function collectFindings(path: string): Finding[] {
  const relativePath = relative(REPO_ROOT, path);
  const contents = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: Finding[] = [];
  const addFinding = (node: ts.Node, kind: string, value: string | undefined): void => {
    if (!isVisibleLiteral(value)) return;
    findings.push({
      file: relativePath,
      kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      value,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      addFinding(node, 'JSX text', normalizeLiteral(node.text));
    } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
      for (const value of visibleExpressionStrings(node.expression)) {
        addFinding(node, 'JSX expression text', value);
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (VISIBLE_ATTRIBUTES.has(name))
        addFinding(node, `JSX ${name}`, staticString(node.initializer));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (
        /^(?:window\.)?(?:alert|confirm)$|(?:^|\.)toast(?:\.|$)/.test(callee) &&
        !callee.endsWith('.dismiss')
      ) {
        addFinding(node, `${callee} argument`, staticString(node.arguments[0]));
      }
      if (callee.endsWith('showErrorBox')) {
        addFinding(node, 'showErrorBox title', staticString(node.arguments[0]));
        addFinding(node, 'showErrorBox message', staticString(node.arguments[1]));
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      NATIVE_UI_PATHS.some(prefix => relativePath.startsWith(prefix))
    ) {
      const name = propertyName(node.name);
      if (name !== undefined && NATIVE_VISIBLE_PROPERTIES.has(name)) {
        if (name === 'buttons' && ts.isArrayLiteralExpression(node.initializer)) {
          for (const element of node.initializer.elements) {
            addFinding(element, 'native button', staticString(element));
          }
        } else {
          addFinding(node, `native ${name}`, staticString(node.initializer));
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

describe('localized interface source coverage', () => {
  it('scans the shared library and at least one application', () => {
    for (const root of REQUIRED_SOURCE_ROOTS)
      expect(existsSync(resolve(REPO_ROOT, root))).toBe(true);
    expect(SOURCE_ROOTS.length).toBeGreaterThan(REQUIRED_SOURCE_ROOTS.length);
  });

  // Walks and parses every source file under SOURCE_ROOTS: well under a second locally, ~9s on
  // a cold CI runner, so the default 5s budget is a flake, not a signal.
  it('contains no unreviewed raw user-visible strings', () => {
    const findings = SOURCE_ROOTS.flatMap(root =>
      listSourceFiles(resolve(REPO_ROOT, root))
    ).flatMap(collectFindings);
    const unreviewed = findings.filter(({ value }) => !REVIEWED_VISIBLE_LITERALS.has(value));

    expect(unreviewed).toEqual([]);
  }, 60_000);
});
