---
title: "no-request-suffix"
---

```text title="Full name"
@azure-tools/typespec-client-generator-core/no-request-suffix
```

Model names ending with `Request` should be renamed to `Content` or another appropriate suffix. This rule checks the C#-resolved name (respecting `@clientName` overrides).

#### ❌ Incorrect

```tsp
model PredictionRequest {
  value: string;
}
```

#### ✅ Correct

```tsp
model PredictionContent {
  value: string;
}
```

```tsp
@clientName("PredictionContent", "csharp")
model PredictionRequest {
  value: string;
}
```
