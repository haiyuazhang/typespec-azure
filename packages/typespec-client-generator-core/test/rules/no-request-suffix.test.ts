import { LinterRuleTester, createLinterRuleTester } from "@typespec/compiler/testing";
import { beforeEach, describe, it } from "vitest";
import { noRequestSuffixRule } from "../../src/rules/no-request-suffix.js";
import { SimpleTester } from "../tester.js";

let tester: LinterRuleTester;

beforeEach(async () => {
  const runner = await SimpleTester.createInstance();
  tester = createLinterRuleTester(
    runner,
    noRequestSuffixRule,
    "@azure-tools/typespec-client-generator-core",
  );
});

it("emits warning when model name ends with Request", async () => {
  await tester
    .expect(
      `model PredictionRequest {
        value: string;
      }`,
    )
    .toEmitDiagnostics({
      code: "@azure-tools/typespec-client-generator-core/no-request-suffix",
      message:
        "Model name 'PredictionRequest' should not end with 'Request'. Consider renaming to 'PredictionContent' or use @clientName(\"PredictionContent\", \"csharp\").",
    });
});

it("is valid when model name does not end with Request", async () => {
  await tester
    .expect(
      `model PredictionContent {
        value: string;
      }`,
    )
    .toBeValid();
});

it("is valid when model name ends with Requests (plural)", async () => {
  await tester
    .expect(
      `model BatchRequests {
        items: string[];
      }`,
    )
    .toBeValid();
});

it("does not flag model named exactly Request", async () => {
  await tester
    .expect(
      `model Request {
        id: string;
      }`,
    )
    .toBeValid();
});

it("is case-sensitive - does not flag lowercase request", async () => {
  await tester
    .expect(
      `model Myrequest {
        value: string;
      }`,
    )
    .toBeValid();
});

it("is valid when @clientName removes Request suffix", async () => {
  await tester
    .expect(
      `@clientName("PredictionContent", "csharp")
      model PredictionRequest {
        value: string;
      }`,
    )
    .toBeValid();
});

it("emits warning when @clientName still ends with Request", async () => {
  await tester
    .expect(
      `@clientName("MyPredictionRequest", "csharp")
      model SomePrediction {
        value: string;
      }`,
    )
    .toEmitDiagnostics({
      code: "@azure-tools/typespec-client-generator-core/no-request-suffix",
    });
});

it("does not flag non-model types", async () => {
  await tester.expect(`scalar RequestId extends string;`).toBeValid();
});

describe("codefix", () => {
  it("offers @@clientName in client.tsp codefix", async () => {
    await tester
      .expect(
        `model PredictionRequest {
          value: string;
        }`,
      )
      .toEmitDiagnostics({
        code: "@azure-tools/typespec-client-generator-core/no-request-suffix",
      });
  });
});
