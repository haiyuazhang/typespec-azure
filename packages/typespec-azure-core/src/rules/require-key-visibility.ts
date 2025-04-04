import {
  Model,
  createRule,
  getLifecycleVisibilityEnum,
  getVisibilityForClass,
  isKey,
  paramMessage,
} from "@typespec/compiler";
import { isExcludedCoreType, isInlineModel, isTemplateDeclarationType } from "./utils.js";

export const requireKeyVisibility = createRule({
  name: "key-visibility-required",
  description: "Key properties need to have a Lifecycle visibility setting.",
  severity: "warning",
  messages: {
    default: paramMessage`The key property '${"name"}' has default Lifecycle visibility, please use the @visibility decorator to change it.`,
  },
  create(context) {
    const Lifecycle = getLifecycleVisibilityEnum(context.program);
    return {
      model: (model: Model) => {
        if (
          !isTemplateDeclarationType(model) &&
          !isInlineModel(model) &&
          !isExcludedCoreType(context.program, model) &&
          model.name !== "object"
        ) {
          for (const [name, prop] of model.properties) {
            const hasExplicitVisibility =
              getVisibilityForClass(context.program, prop, Lifecycle).size !==
              Lifecycle.members.size;

            if (isKey(context.program, prop) && !hasExplicitVisibility) {
              context.reportDiagnostic({
                target: prop,
                format: { name },
              });
            }
          }
        }
      },
    };
  },
});
