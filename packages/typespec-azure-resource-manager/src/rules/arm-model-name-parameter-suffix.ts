import { Model, createRule, paramMessage } from "@typespec/compiler";

export const armModelNameParameterSuffixRule = createRule({
  name: "arm-model-name-parameter-suffix",
  severity: "warning",
  description: "Model names should not end with 'Parameter' or 'Parameters'. Use 'Content' or 'Patch' instead.",
  url: "https://azure.github.io/typespec-azure/docs/libraries/azure-resource-manager/rules/model-name-parameter-suffix",
  messages: {
    default: paramMessage`Model name "${"modelName"}" should not end with "Parameter" or "Parameters". Consider using "Content" or "Patch" instead.`,
  },
  create(context) {
    return {
      model: (model: Model) => {
        const modelName = model.name;
        
        // Check if the model name ends with "Parameter" or "Parameters"
        if (modelName.endsWith("Parameter") || modelName.endsWith("Parameters")) {
          context.reportDiagnostic({
            format: { modelName: modelName },
            target: model,
          });
        }
      },
    };
  },
});