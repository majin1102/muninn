"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSettingsJson = validateSettingsJson;

function validateSettingsJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("muninn.json must be a JSON object.");
  }

  const root = parsed;
  if (root.llm !== undefined) {
    throw new Error("llm is no longer supported; use providers.llm instead.");
  }
  if (root.extraction !== undefined) {
    throw new Error("extraction is no longer supported; use extractor.embeddingProvider and extractor.recallMode instead.");
  }
  if (root.semanticIndex !== undefined) {
    throw new Error("semanticIndex is no longer supported; use extractor.embeddingProvider instead.");
  }

  validateStorage(root.storage);
  validateTurn(root.turn);
  validateExtractor(root.extractor);
  validateObserver(root.observer);
  validateProviders(root.providers);
  validateWatchdog(root.watchdog);
}

function validateStorage(storage) {
  if (storage === undefined) {
    return;
  }
  const config = expectObject(storage, "storage");
  if (typeof config.uri !== "string" || !config.uri.trim()) {
    throw new Error("storage.uri must be a non-empty string.");
  }
  if (config.storageOptions !== undefined) {
    const storageOptions = expectObject(config.storageOptions, "storage.storageOptions");
    for (const [key, value] of Object.entries(storageOptions)) {
      if (typeof value !== "string") {
        throw new Error(`storage.storageOptions.${key} must be a string.`);
      }
    }
  }
}

function validateTurn(turn) {
  if (turn === undefined) {
    return;
  }
  const config = expectObject(turn, "turn");
  if (config.llm !== undefined) {
    throw new Error("turn.llm is no longer supported; use turn.llmProvider instead.");
  }
  validateOptionalString(config.llmProvider, "turn.llmProvider");
  validateOptionalPositiveInteger(config.llmSummaryThresholdChars, "turn.llmSummaryThresholdChars");
  validateOptionalPositiveInteger(config.titleMaxChars, "turn.titleMaxChars");
}

function validateExtractor(extractor) {
  if (extractor === undefined) {
    return;
  }
  const config = expectObject(extractor, "extractor");
  if (config.llm !== undefined) {
    throw new Error("extractor.llm is no longer supported; use extractor.llmProvider instead.");
  }
  if (config.defaultImportance !== undefined) {
    throw new Error("extractor.defaultImportance is not supported; Muninn uses an internal default importance.");
  }
  for (const key of ["name", "llmProvider", "embeddingProvider"]) {
    validateOptionalString(config[key], `extractor.${key}`);
  }
  if (config.recallMode !== undefined && !["vector", "fts", "hybrid"].includes(String(config.recallMode))) {
    throw new Error("extractor.recallMode must be one of: vector, fts, hybrid.");
  }
  for (const key of ["maxAttempts", "activeWindowDays", "continuityHints", "epochTurns", "epochWindowMs"]) {
    validateOptionalPositiveInteger(config[key], `extractor.${key}`);
  }
}

function validateObserver(observer) {
  if (observer === undefined) {
    return;
  }
  const config = expectObject(observer, "observer");
  if (config.llm !== undefined) {
    throw new Error("observer.llm is no longer supported; use observer.llmProvider instead.");
  }
  for (const key of ["name", "llmProvider"]) {
    validateOptionalString(config[key], `observer.${key}`);
  }
  for (const key of ["maxAttempts", "activeWindowDays", "anchorThreshold", "anchorBatchSize", "contentBudgetChars"]) {
    validateOptionalPositiveInteger(config[key], `observer.${key}`);
  }
}

function validateProviders(providers) {
  if (providers === undefined) {
    return;
  }
  const config = expectObject(providers, "providers");
  validateProviderGroup(config.llm, "providers.llm", ["type", "model", "api", "apiKey", "baseUrl"]);
  validateProviderGroup(config.embedding, "providers.embedding", ["type", "model", "apiKey", "baseUrl"]);
  if (config.embedding && typeof config.embedding === "object" && !Array.isArray(config.embedding)) {
    for (const [name, section] of Object.entries(config.embedding)) {
      validateOptionalPositiveInteger(section?.dimensions, `providers.embedding.${name}.dimensions`);
    }
  }
}

function validateProviderGroup(group, label, keys) {
  if (group === undefined) {
    return;
  }
  const providers = expectObject(group, label);
  for (const [name, section] of Object.entries(providers)) {
    const provider = expectObject(section, `${label}.${name}`);
    if (typeof provider.type !== "string" || provider.type.trim() === "") {
      throw new Error(`${label}.${name}.type must be a non-empty string.`);
    }
    for (const key of keys) {
      validateOptionalString(provider[key], `${label}.${name}.${key}`);
    }
    if (provider.type === "openai" && (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "")) {
      throw new Error(`${label}.${name}.apiKey must be a non-empty string.`);
    }
  }
}

function validateWatchdog(watchdog) {
  if (watchdog === undefined) {
    return;
  }
  const config = expectObject(watchdog, "watchdog");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error("watchdog.enabled must be a boolean.");
  }
  for (const key of ["intervalMs", "compactMinFragments"]) {
    validateOptionalPositiveInteger(config[key], `watchdog.${key}`);
  }
  if (config.extraction !== undefined) {
    const extraction = expectObject(config.extraction, "watchdog.extraction");
    for (const key of ["targetPartitionSize", "optimizeMergeCount"]) {
      validateOptionalPositiveInteger(extraction[key], `watchdog.extraction.${key}`);
    }
  }
}

function expectObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object if provided.`);
  }
  return value;
}

function validateOptionalString(value, label) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
}

function validateOptionalPositiveInteger(value, label) {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
