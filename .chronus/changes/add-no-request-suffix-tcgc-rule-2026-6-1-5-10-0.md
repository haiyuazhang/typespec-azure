---
changeKind: feature
packages:
  - "@azure-tools/typespec-client-generator-core"
---

Add `no-request-suffix` linter rule that flags model names ending with `Request` (using C#-resolved name via `getLibraryName`) and suggests renaming to `Content`.
