import {
  BasicTestRunner,
  LinterRuleTester,
  createLinterRuleTester,
} from "@typespec/compiler/testing";
import { beforeEach, it } from "vitest";
import { armModelNameParameterSuffixRule } from "../../src/rules/arm-model-name-parameter-suffix.js";
import { createAzureResourceManagerTestRunner } from "../test-host.js";

const armDef = `
@armProviderNamespace
@useDependency(Azure.ResourceManager.Versions.v1_0_Preview_1)
namespace Microsoft.Contoso;
`;

let runner: BasicTestRunner;
let tester: LinterRuleTester;

beforeEach(async () => {
  runner = await createAzureResourceManagerTestRunner();
  tester = createLinterRuleTester(
    runner,
    armModelNameParameterSuffixRule,
    "@azure-tools/typespec-azure-resource-manager",
  );
});

it("emits diagnostic when model name ends with 'Parameter'", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model CreateParameter { 
        name: string;
      } 
        `,
    )
    .toEmitDiagnostics({
      code: "@azure-tools/typespec-azure-resource-manager/arm-model-name-parameter-suffix",
      message: `Model name "CreateParameter" should not end with "Parameter" or "Parameters". Consider using "Content" or "Patch" instead.`,
    });
});

it("emits diagnostic when model name ends with 'Parameters'", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model UpdateParameters { 
        name: string;
      } 
        `,
    )
    .toEmitDiagnostics({
      code: "@azure-tools/typespec-azure-resource-manager/arm-model-name-parameter-suffix",
      message: `Model name "UpdateParameters" should not end with "Parameter" or "Parameters". Consider using "Content" or "Patch" instead.`,
    });
});

it("valid when model name ends with 'Content'", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model CreateContent { 
        name: string;
      } 
        `,
    )
    .toBeValid();
});

it("valid when model name ends with 'Patch'", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model UpdatePatch { 
        name: string;
      } 
        `,
    )
    .toBeValid();
});

it("valid when model name does not end with Parameter or Parameters", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model Widget { 
        name: string;
      } 
        `,
    )
    .toBeValid();
});

it("valid when model name contains 'Parameter' but doesn't end with it", async () => {
  await tester
    .expect(
      ` 
      ${armDef}
      model ParameterizedWidget { 
        name: string;
      } 
        `,
    )
    .toBeValid();
});