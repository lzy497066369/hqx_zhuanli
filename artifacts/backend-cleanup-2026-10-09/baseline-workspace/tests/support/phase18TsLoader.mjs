import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        try { return await nextResolve(specifier + extension, context); } catch {}
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!/\.tsx?$/i.test(url)) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const result = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true,
  } });
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
