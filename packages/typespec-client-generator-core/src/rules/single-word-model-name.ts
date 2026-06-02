import {
  Model,
  createRule,
  createSourceFile,
  getDirectoryPath,
  getNamespaceFullName,
  getSourceLocation,
  paramMessage,
  resolvePath,
} from "@typespec/compiler";
import type {
  CodeFix,
  CodeFixContext,
  CompilerHost,
  InsertTextCodeFixEdit,
} from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
import { createTCGCContext } from "../context.js";
import { getLibraryName } from "../public-utils.js";

/**
 * Splits a PascalCase name into logical words, handling acronyms.
 * "TableDocument" → ["Table", "Document"]
 * "HTTPClient" → ["HTTP", "Client"]
 * "Document" → ["Document"]
 */
function splitPascalCase(name: string): string[] {
  const words: string[] = [];
  let current = "";

  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    const isUpper = char >= "A" && char <= "Z";
    const nextIsLower = i + 1 < name.length && name[i + 1] >= "a" && name[i + 1] <= "z";

    if (isUpper && current.length > 0) {
      const prevIsLower =
        current[current.length - 1] >= "a" && current[current.length - 1] <= "z";
      if (prevIsLower) {
        words.push(current);
        current = char;
      } else if (nextIsLower) {
        words.push(current);
        current = char;
      } else {
        current += char;
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

function isSingleWord(name: string): boolean {
  if (name.length <= 1) return false;
  if (!/^[A-Z]/.test(name)) return false;
  return splitPascalCase(name).length <= 1;
}

/**
 * Fetch multiple AI name suggestions via the LSP bridge to vscode.lm.
 */
async function fetchAiNameSuggestions(
  modelName: string,
  namespaceName: string,
  modelSource: string,
): Promise<string[]> {
  console.log("@@@ Fetching AI suggestions via LSP bridge");

  const connection = (globalThis as any).lspConnection;
  if (!connection) {
    console.log("@@@ No LSP connection available");
    return [];
  }

  const prompt = `You are a .NET naming expert. A TypeSpec model named "${modelName}" in namespace "${namespaceName}" is a single word that may collide with BCL types.

Model definition:
${modelSource}

Suggest exactly 5 better multi-word PascalCase names. Order by confidence.
Reply with ONLY the 5 names, one per line. No explanations, no numbering, no backticks.`;

  try {
    const result = await connection.sendRequest("custom/chatCompletion", {
      messages: [{ role: "user", message: prompt }],
      modelFamily: "claude-opus-4.6",
      id: `single-word-suggestions-${modelName}`,
    });
    console.log(`@@@ AI response: '${result}'`);

    if (typeof result !== "string" || !result.trim()) return [];

    const suggestions = result
      .split("\n")
      .map((line: string) => line.trim().replace(/^`+|`+$/g, "").replace(/^\d+\.\s*/, "").trim())
      .filter((name: string) => name && /^[A-Z][a-zA-Z0-9]*$/.test(name) && !isSingleWord(name));

    console.log(`@@@ Parsed ${suggestions.length} valid suggestions: ${suggestions.join(", ")}`);
    return suggestions;
  } catch (e: any) {
    console.log(`@@@ LSP request failed: ${e.message}`);
    return [];
  }
}

/**
 * Extract the model's source text for AI context.
 */
function extractModelSource(model: Model): string {
  if (model.node === undefined || model.node.kind !== SyntaxKind.ModelStatement) return "";
  const location = getSourceLocation(model.node);
  const text = location.file.text;
  const start = model.node.pos;
  const end = model.node.end;
  return text.slice(start, end).trim();
}

/**
 * Create a codefix that writes @@clientName to client.tsp with a specific name.
 */
function createClientNameCodeFix(
  model: Model,
  host: CompilerHost,
  newName: string,
  index: number,
): CodeFix {
  return {
    id: `ai-rename-single-word-${index}`,
    label: `Rename to '${newName}' in client.tsp`,
    fix: (async (_fixContext: CodeFixContext): Promise<any> => {
      if (model.node === undefined) return [];
      const modelSourcePath = getSourceLocation(model.node).file.path;
      const dir = getDirectoryPath(modelSourcePath);
      const clientTspPath = resolvePath(dir, "client.tsp");

      let existingText = "";
      try {
        const file = await host.readFile(clientTspPath);
        existingText = file.text;
      } catch {
        // File doesn't exist yet
      }

      const modelFileName = modelSourcePath.split("/").pop() ?? "main.tsp";
      const importPath = `./${modelFileName}`;
      const tcgcImport = `import "@azure-tools/typespec-client-generator-core";\n`;
      const modelImport = `import "${importPath}";\n`;
      const usingLine = `using Azure.ClientGenerator.Core;\n`;

      let textToAppend = "";
      if (!existingText.includes(tcgcImport.trim())) {
        textToAppend += tcgcImport;
      }
      if (!existingText.includes(modelImport.trim())) {
        textToAppend += modelImport;
      }
      if (!existingText.includes(usingLine.trim())) {
        textToAppend += `\n${usingLine}`;
      }
      if (textToAppend.length > 0 && existingText.length === 0) {
        textToAppend += "\n";
      }
      const fqn = model.namespace
        ? `${getNamespaceFullName(model.namespace)}.${model.name}`
        : model.name;
      textToAppend += `@@clientName(${fqn}, "${newName}", "csharp");\n`;

      const clientFile = createSourceFile(existingText, clientTspPath);
      const edit: InsertTextCodeFixEdit = {
        kind: "insert-text",
        pos: existingText.length,
        text: textToAppend,
        file: clientFile,
      };
      return edit;
    }) as CodeFix["fix"],
  };
}

/**
 * Create a codefix that uses resolveCodefixes to fetch AI suggestions
 * and present them as individual labeled options in the Ctrl+. menu.
 */
function createAiClientNameCodeFix(model: Model, host: CompilerHost, csharpName: string) {
  const namespaceName = model.namespace ? getNamespaceFullName(model.namespace) : "";
  const modelSource = extractModelSource(model);

  const codeFix: CodeFix = {
    id: "ai-rename-single-word",
    label: "AI: Suggest multi-word names...",
    fix: (async (): Promise<any> => {
      // Fallback if resolveCodefixes wasn't called (e.g., CLI usage)
      return [];
    }) as CodeFix["fix"],
    resolveCodefixes: async () => {
      console.log("@@@ resolveCodefixes called — fetching AI suggestions");
      const suggestions = await fetchAiNameSuggestions(csharpName, namespaceName, modelSource);
      if (suggestions.length === 0) {
        // Fallback: return a single codefix with a simple suffix
        const fallback = `${namespaceName.split(".").pop() ?? "Service"}${csharpName}`;
        return [createClientNameCodeFix(model, host, fallback, 0)];
      }
      return suggestions.map((name, i) =>
        createClientNameCodeFix(model, host, name, i),
      );
    },
  };
  return codeFix;
}

export const singleWordModelNameRule = createRule({
  name: "single-word-model-name",
  description:
    "Model names should be multi-word to avoid naming collisions with BCL or third-party types.",
  severity: "warning",
  url: "https://azure.github.io/typespec-azure/docs/libraries/typespec-client-generator-core/rules/single-word-model-name",
  messages: {
    default: paramMessage`Model name '${"modelName"}' is a single word. Consider using a more descriptive multi-word name to avoid naming collisions.`,
    clientNameSingleWord: paramMessage`Client name override '${"newName"}' for model '${"modelName"}' is still a single word. Use a multi-word name to avoid naming collisions.`,
  },
  create(context) {
    const tcgcContext = createTCGCContext(
      context.program,
      "@azure-tools/typespec-client-generator-core",
      { mutateNamespace: false },
    );
    return {
      model: (model: Model) => {
        if (model.node === undefined || model.node.kind !== SyntaxKind.ModelStatement) return;
        // Skip library/node_modules types
        const location = getSourceLocation(model.node);
        if (location.file.path.includes("node_modules")) return;
        // Skip template declarations
        if (model.templateMapper !== undefined) return;

        const csharpName = getLibraryName(tcgcContext, model, "csharp");

        if (isSingleWord(csharpName)) {
          // Check if the single-word name comes from a @clientName override
          const rawName = model.name;
          if (csharpName !== rawName) {
            // @clientName override produced a single-word name
            context.reportDiagnostic({
              messageId: "clientNameSingleWord",
              format: { newName: csharpName, modelName: rawName },
              target: model,
              codefixes: [
                createAiClientNameCodeFix(model, context.program.host, csharpName),
              ],
            });
          } else {
            context.reportDiagnostic({
              messageId: "default",
              format: { modelName: csharpName },
              target: model,
              codefixes: [
                createAiClientNameCodeFix(model, context.program.host, csharpName),
              ],
            });
          }
        }
      },
    };
  },
});
