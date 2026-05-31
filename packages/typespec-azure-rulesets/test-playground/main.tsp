import "@azure-tools/typespec-azure-core";

using Azure.Core;

#suppress "@azure-tools/typespec-azure-core/auth-required" ""
#suppress "@azure-tools/typespec-azure-core/require-versioned" ""
@service
namespace Azure.TestService;

/** A prediction request payload. */
model PredictionRequest {
  /** The input value. */
  value: string;
}
