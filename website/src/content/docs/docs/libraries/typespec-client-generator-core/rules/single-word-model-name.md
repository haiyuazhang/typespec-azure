---
title: "single-word-model-name"
---

```text title="Full name"
@azure-tools/typespec-client-generator-core/single-word-model-name
```

Model names should be multi-word to avoid naming collisions with BCL or third-party types (e.g. `System.Document`). The codefix uses AI to suggest a contextual multi-word name.

#### ❌ Incorrect

```tsp
model Document {
  id: string;
}
```

#### ✅ Correct

```tsp
model TableDocument {
  id: string;
}
```

```tsp
@clientName("StorageDocument", "csharp")
model Document {
  id: string;
}
```
