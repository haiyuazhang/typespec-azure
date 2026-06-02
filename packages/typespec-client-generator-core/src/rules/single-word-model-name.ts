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
 * EXPERIMENT: Try to use vscode.lm directly from the linter codefix.
 * This will BUILD successfully (TypeScript resolves @types/vscode)
 * but CRASH at runtime (vscode module doesn't exist in the language server process).
 */
async function fetchAiNameSuggestionViaVscodeLm(
  modelName: string,
  namespaceName: string,
  modelSource: string,
): Promise<string | undefined> {
  // This import will CRASH at runtime with MODULE_NOT_FOUND
  // because the codefix runs in the TypeSpec language server process,
  // not in the VS Code extension host where vscode module is available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode") as any;

  const models = await vscode.lm.selectChatModels({ family: "gpt-4.1" });
  if (models.length === 0) return undefined;

  const chatModel = models[0];
  const prompt = `You are a .NET SDK naming expert. A TypeSpec model is named "${modelName}" in namespace "${namespaceName}". This single-word name may collide with BCL or third-party types.

Here is the model definition:
${modelSource}

Suggest ONE better multi-word PascalCase name that:
- Is descriptive and contextual
- Avoids collisions with System.* types
- Follows .NET naming conventions

Reply with ONLY the new name, nothing else.`;

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await chatModel.sendRequest(messages);

  let result = "";
  for await (const chunk of response.text) {
    result += chunk;
  }

  const suggestion = result.trim();
  if (suggestion && /^[A-Z][a-zA-Z0-9]*$/.test(suggestion) && !isSingleWord(suggestion)) {
    return suggestion;
  }
  return undefined;
}

/**
 * Extract the model's source text for AI context.
 */
function extractModelSource(model: Model): string {
  if (model.node === undefined || model.node.kind !== SyntaxKind.ModelStatement) return "";
  const location = getSourceLocation(model.node);
  const text = location.file.text;
  // Extract from "model Name {" to the closing "}"
  const start = model.node.pos;
  const end = model.node.end;
  return text.slice(start, end).trim();
}

function createAiClientNameCodeFix(model: Model, host: CompilerHost, csharpName: string) {
  const namespaceName = model.namespace ? getNamespaceFullName(model.namespace) : "";
  const modelSource = extractModelSource(model);

  const codeFix: CodeFix = {
    id: "ai-rename-single-word",
    label: `Add @@clientName to client.tsp (AI-suggested)`,
    fix: (async (_fixContext: CodeFixContext): Promise<any> => {
      if (model.node === undefined) return [];

      const aiName = await fetchAiNameSuggestionViaVscodeLm(csharpName, namespaceName, modelSource);
      if (!aiName) return []; // No AI suggestion available

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
      textToAppend += `@@clientName(${fqn}, "${aiName}", "csharp");\n`;

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
