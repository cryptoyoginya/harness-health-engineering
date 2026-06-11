// graders/json-schema.mjs — проверка что output содержит валидный JSON по схеме.
//
// Формат секции "# Expected":
//   ```json
//   { "type": "object", "required": ["title", "tags"], "properties": { ... } }
//   ```
//
// Использует zod-style ручную валидацию (минимально), чтобы не тянуть ajv.
// Поддержка базового JSON Schema подмножества:
//   - type: "object" | "array" | "string" | "number" | "boolean"
//   - required: [string]
//   - properties: { key: subschema }
//   - items: subschema (для массивов)
//   - enum: [values]
//   - minLength / maxLength (string), minimum / maximum (number)
//
// Output парсится: сначала ищет ```json ... ``` блок, иначе пробует целиком как JSON.

const GRADER_VERSION = "json-schema/0.1";
const JSON_FENCE_RE = /```json\s*\n?([\s\S]*?)```/i;

export const JSON_SCHEMA_GRADER = {
  name: "json-schema",
  version: GRADER_VERSION,
  grade(output, expected) {
    const schemaText = extractSchemaFromExpected(expected);
    if (!schemaText) {
      return { passed: false, score: 0, details: { error: "не найдена JSON Schema в # Expected", grader_version: GRADER_VERSION } };
    }
    let schema;
    try {
      schema = JSON.parse(schemaText);
    } catch (e) {
      return { passed: false, score: 0, details: { error: `невалидная JSON Schema: ${e.message}`, grader_version: GRADER_VERSION } };
    }

    const candidate = extractJsonFromOutput(output);
    if (candidate.error) {
      return { passed: false, score: 0, details: { error: candidate.error, grader_version: GRADER_VERSION } };
    }

    const errors = validate(candidate.value, schema, "$");
    return {
      passed: errors.length === 0,
      score: errors.length === 0 ? 1 : 0,
      details: { errors, grader_version: GRADER_VERSION },
    };
  },
};

function extractSchemaFromExpected(expected) {
  const m = JSON_FENCE_RE.exec(expected);
  return m ? m[1].trim() : null;
}

function extractJsonFromOutput(output) {
  const m = JSON_FENCE_RE.exec(output);
  const candidate = m ? m[1].trim() : output.trim();
  try {
    return { value: JSON.parse(candidate) };
  } catch (e) {
    return { error: `output не парсится как JSON: ${e.message}` };
  }
}

function validate(value, schema, path) {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actualType !== schema.type) {
      errors.push(`${path}: ожидался type=${schema.type}, получен ${actualType}`);
      return errors;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: значение должно быть одним из ${JSON.stringify(schema.enum)}`);
    }
  }

  if (schema.type === "object" && value && typeof value === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: отсутствует обязательное поле "${key}"`);
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], subSchema, `${path}.${key}`));
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }

  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path}: длина ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path}: длина ${value.length} > maxLength ${schema.maxLength}`);
    }
  }

  if (schema.type === "number" && typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }

  return errors;
}
