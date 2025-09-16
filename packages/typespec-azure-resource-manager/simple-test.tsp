// This should trigger the linter rule
model CreateParameter {
  name: string;
  value: string;
}

// This should also trigger the linter rule  
model UpdateParameters {
  enabled: boolean;
  count: int32;
}

// These should NOT trigger the linter rule
model CreateContent {
  name: string;
  value: string;
}

model UpdatePatch {
  enabled: boolean;
  count: int32;
}

model SimpleModel {
  id: string;
}

model ParameterizedWidget {
  parameterValue: string;
}