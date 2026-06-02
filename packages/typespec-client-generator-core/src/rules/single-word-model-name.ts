/**
 * single-word-model-name linter rule
 *
 * Flags model names that are a single PascalCase word (e.g. "Document", "Format")
 * because they risk colliding with .NET BCL or third-party types.
 *
 * The fix uses AI (via vscode.lm) to suggest multi-word replacements and writes
 * a @@clientName override to client.tsp. Here's the full flow:
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  COMPILATION (happens when you open/edit a .tsp file)               │
 * │                                                                     │
 * │  1. TypeSpec compiles main.tsp                                      │
 * │  2. Linter runs the model visitor for each model                    │
 * │  3. getLibraryName(ctx, model, "csharp") gets the C#-resolved name  │
 * │     (respects @clientName overrides from client.tsp if imported)    │
 * │  4. If the name is a single word → report warning + attach codefix  │
 * │     The codefix has resolveCodefixes (but it's NOT called yet)      │
 * │  5. Yellow squiggly appears under the model name                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *                              │
 *                    User presses Ctrl+.
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  GET CODE ACTIONS (VS Code → Language Server)                       │
 * │                                                                     │
 * │  6. VS Code sends textDocument/codeAction request                   │
 * │  7. Server sees our codefix has resolveCodefixes → calls it         │
 * │  8. resolveCodefixes calls fetchAiNameSuggestions:                   │
 * │                                                                     │
 * │     Language Server                          VS Code Extension      │
 * │     ──────────────                          ──────────────────      │
 * │     globalThis.lspConnection                                        │
 * │       .sendRequest("custom/chatCompletion") ──────────►             │
 * │                                              sendLmChatRequest()    │
 * │                                              vscode.lm              │
 * │                                                .selectChatModels()  │
 * │                                              model.sendRequest()    │
 * │                                              ◄────── AI response    │
 * │     ◄─── returns "TableDocument\n             (5 suggestions)       │
 * │          StorageDocument\n..."                                       │
 * │                                                                     │
 * │  9. resolveCodefixes creates 5 CodeFix objects, each with:          │
 * │     - A descriptive label: "Rename to 'TableDocument' in client.tsp"│
 * │     - A fix() function that writes @@clientName to client.tsp       │
 * │  10. Server caches the result (Promise-based, so concurrent         │
 * │      requests share the same AI call — no duplicates)               │
 * │  11. Returns 5 code actions to VS Code                              │
 * └──────────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  QUICK FIX MENU (what the user sees)                                │
 * │                                                                     │
 * │  ┌────────────────────────────────────────────┐                     │
 * │  │ 💡 Rename to 'TableDocument' in client.tsp │                     │
 * │  │    Rename to 'StorageDocument' in client.tsp│                    │
 * │  │    Rename to 'TableStorageDocument' ...     │                    │
 * │  │    Rename to 'DocumentEntity' ...           │                    │
 * │  │    Rename to 'TableDocumentEntity' ...      │                    │
 * │  └────────────────────────────────────────────┘                     │
 * │                                                                     │
 * │  12. User picks one (e.g. "TableDocument")                          │
 * └──────────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  RESOLVE CODE ACTION (VS Code → Language Server)                    │
 * │                                                                     │
 * │  13. VS Code sends codeAction/resolve for "TableDocument"           │
 * │  14. Server finds the CodeFix in resolvedCodefixMap by ID           │
 * │  15. Calls fix() which:                                             │
 * │      a. Reads existing client.tsp (or creates empty)                │
 * │      b. Adds import + using lines if missing                        │
 * │      c. Appends: @@clientName(Azure.Storage.Tables.Document,        │
 * │                               "TableDocument", "csharp");           │
 * │  16. Returns the edit to VS Code                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  APPLY (VS Code)                                                    │
 * │                                                                     │
 * │  17. VS Code creates client.tsp if needed (ignoreIfExists)          │
 * │  18. Writes the @@clientName line                                   │
 * │  19. Language server recompiles → getLibraryName now returns         │
 * │      "TableDocument" (multi-word) → warning disappears ✅            │
 * │      (requires imports: ./client.tsp in tspconfig.yaml)             │
 * └──────────────────────────────────────────────────────────────────────┘
 */

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
 *
 * This is where vscode.lm is called — indirectly through the LSP bridge:
 *
 *   Language Server (this code)
 *     │
 *     │  connection.sendRequest("custom/chatCompletion", { messages, modelFamily })
 *     │
 *     ▼
 *   VS Code Extension (tsp-language-client.ts:313)
 *     │
 *     │  lc.onRequest("custom/chatCompletion", params =>
 *     │    sendLmChatRequest(params.messages, params.modelFamily, ...))
 *     │
 *     ▼
 *   sendLmChatRequest (lm/language-model.ts:19)
 *     │
 *     │  vscode.lm.selectChatModels({ family: modelFamily })  ← vscode.lm is called HERE
 *     │  model.sendRequest(messages)                          ← AI request sent HERE
 *     │  for await (chunk of response.text) { ... }           ← AI response streamed HERE
 *     │
 *     ▼
 *   Returns string response back through LSP to this function
 */
async function fetchAiNameSuggestions(
  modelName: string,
  namespaceName: string,
  modelSource: string,
): Promise<string[]> {
  console.log("@@@ Fetching AI suggestions via LSP bridge");

  // globalThis.lspConnection is set by the TypeSpec language server (server.ts:156)
  // It's the LSP JSON-RPC connection between the language server and VS Code
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
    // >>> This is the LSP bridge call that ultimately reaches vscode.lm <<<
    //
    // Calling chain with file locations:
    //
    // HERE: connection.sendRequest("custom/chatCompletion", { messages, modelFamily })
    //   │
    //   ▼  (LSP JSON-RPC)
    // core/packages/typespec-vscode/src/tsp-language-client.ts:313
    //   lc.onRequest("custom/chatCompletion", (params) =>
    //     sendLmChatRequest(params.messages, params.modelFamily, params.options, params.id))
    //   │
    //   ▼
    // core/packages/typespec-vscode/src/lm/language-model.ts:56
    //   lm.selectChatModels({ family: modelFamily })     ← vscode.lm called here
    //   │
    //   ▼
    // core/packages/typespec-vscode/src/lm/language-model.ts:91
    //   selectedModel.sendRequest(messages)               ← AI request sent here
    //   │
    //   ▼
    // core/packages/typespec-vscode/src/lm/language-model.ts:104-107
    //   for await (const chunk of response.text) {        ← AI response streamed here
    //     fullResponse += chunk;
    //   }
    //   return fullResponse;                              ← returned back through LSP
    //
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
