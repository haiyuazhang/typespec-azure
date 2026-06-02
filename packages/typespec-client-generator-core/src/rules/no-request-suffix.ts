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
import type { CodeFix, CodeFixContext, CompilerHost, InsertTextCodeFixEdit } from "@typespec/compiler";
import { createTCGCContext } from "../context.js";
import { getLibraryName } from "../public-utils.js";

function createClientNameInClientTspCodeFix(model: Model, host: CompilerHost, csharpName: string) {
  const newName = csharpName.replace(/Request$/, "Content");
  const codeFix: CodeFix = {
    id: "rename-request-to-content",
    label: `Add @@clientName to client.tsp → "${newName}"`,
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
        // File doesn't exist yet — will be created by the language server
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
  return codeFix;
}

export const noRequestSuffixRule = createRule({
  name: "no-request-suffix",
  description:
    "Model names ending with 'Request' should be renamed to 'Content' or another appropriate suffix.",
  severity: "warning",
  url: "https://azure.github.io/typespec-azure/docs/libraries/typespec-client-generator-core/rules/no-request-suffix",
  messages: {
    default: paramMessage`Model name '${"name"}' should not end with 'Request'. Consider renaming to '${"suggestion"}' or use @clientName("${"suggestion"}", "csharp").`,
  },
  create(context) {
    const tcgcContext = createTCGCContext(
      context.program,
      "@azure-tools/typespec-client-generator-core",
      { mutateNamespace: false },
    );
    return {
      model: (model: Model) => {
        if (model.node === undefined) return;
        const csharpName = getLibraryName(tcgcContext, model, "csharp");
        if (!csharpName.endsWith("Request")) return;
        if (csharpName === "Request") return;

        const suggestion = csharpName.replace(/Request$/, "Content");
        context.reportDiagnostic({
          format: { name: csharpName, suggestion },
          target: model,
          codefixes: [
            createClientNameInClientTspCodeFix(model, context.program.host, csharpName),
          ],
        });
      },
    };
  },
});
