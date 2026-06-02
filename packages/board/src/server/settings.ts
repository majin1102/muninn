export function validateSettingsJson(text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('muninn.json must be a JSON object.');
  }

  const root = parsed as Record<string, unknown>;
  if (root.llm !== undefined) {
    throw new Error('llm is no longer supported; use providers.llm instead.');
  }
  if (root.extraction !== undefined) {
    throw new Error('extraction is no longer supported; use extractor.embeddingProvider and extractor.recallMode instead.');
  }
  const storage = root.storage;
  if (storage !== undefined) {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
      throw new Error('storage must be an object if provided.');
    }

    const config = storage as Record<string, unknown>;
    if (typeof config.uri !== 'string' || !config.uri.trim()) {
      throw new Error('storage.uri must be a non-empty string.');
    }
    const storageOptions = config.storageOptions;
    if (storageOptions !== undefined) {
      if (
        !storageOptions ||
        typeof storageOptions !== 'object' ||
        Array.isArray(storageOptions)
      ) {
        throw new Error('storage.storageOptions must be an object if provided.');
      }
      for (const [key, value] of Object.entries(storageOptions as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new Error(`storage.storageOptions.${key} must be a string.`);
        }
      }
    }
  }

  const turn = root.turn;
  if (turn !== undefined) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      throw new Error('turn must be an object if provided.');
    }

    const config = turn as Record<string, unknown>;
    if (config.llm !== undefined) {
      throw new Error('turn.llm is no longer supported; use turn.llmProvider instead.');
    }
    if (config.llmProvider !== undefined && typeof config.llmProvider !== 'string') {
      throw new Error('turn.llmProvider must be a string.');
    }
    for (const key of ['llmSummaryThresholdChars', 'titleMaxChars']) {
      const value = config[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        throw new Error(`turn.${key} must be a positive integer.`);
      }
    }
  }

  const observer = root.observer;
  if (observer !== undefined) {
    if (!observer || typeof observer !== 'object' || Array.isArray(observer)) {
      throw new Error('observer must be an object if provided.');
    }

    const config = observer as Record<string, unknown>;
    if (config.llm !== undefined) {
      throw new Error('observer.llm is no longer supported; use observer.llmProvider instead.');
    }
    for (const key of ['name', 'llmProvider']) {
      const value = config[key];
      if (value !== undefined && typeof value !== 'string') {
        throw new Error(`observer.${key} must be a string.`);
      }
    }
    for (const key of ['maxAttempts', 'activeWindowDays', 'anchorThreshold', 'anchorBatchSize', 'contentBudgetChars']) {
      const value = config[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        throw new Error(`observer.${key} must be a positive integer.`);
      }
    }
  }

  const extractor = root.extractor;
  if (extractor !== undefined) {
    if (!extractor || typeof extractor !== 'object' || Array.isArray(extractor)) {
      throw new Error('extractor must be an object if provided.');
    }

    const config = extractor as Record<string, unknown>;
    if (config.llm !== undefined) {
      throw new Error('extractor.llm is no longer supported; use extractor.llmProvider instead.');
    }
    if (config.defaultImportance !== undefined) {
      throw new Error('extractor.defaultImportance is not supported; Muninn uses an internal default importance.');
    }
    for (const key of ['name', 'llmProvider', 'embeddingProvider']) {
      const value = config[key];
      if (value !== undefined && typeof value !== 'string') {
        throw new Error(`extractor.${key} must be a string.`);
      }
    }
    if (config.recallMode !== undefined && !['vector', 'fts', 'hybrid'].includes(String(config.recallMode))) {
      throw new Error('extractor.recallMode must be one of: vector, fts, hybrid.');
    }
    for (const key of ['maxAttempts', 'activeWindowDays', 'continuityHints', 'epochTurns', 'epochWindowMs']) {
      const value = config[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        throw new Error(`extractor.${key} must be a positive integer.`);
      }
    }
  }

  const providers = root.providers;
  if (providers !== undefined) {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      throw new Error('providers must be an object if provided.');
    }
    const config = providers as Record<string, unknown>;
    const llm = config.llm;
    if (llm !== undefined) {
      if (!llm || typeof llm !== 'object' || Array.isArray(llm)) {
        throw new Error('providers.llm must be an object if provided.');
      }
      for (const [name, section] of Object.entries(llm as Record<string, unknown>)) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
          throw new Error(`providers.llm.${name} must be an object.`);
        }

        const providerConfig = section as Record<string, unknown>;
        if (typeof providerConfig.type !== 'string' || providerConfig.type.trim() === '') {
          throw new Error(`providers.llm.${name}.type must be a non-empty string.`);
        }
        for (const key of ['type', 'model', 'api', 'apiKey', 'baseUrl']) {
          const value = providerConfig[key];
          if (value !== undefined && typeof value !== 'string') {
            throw new Error(`providers.llm.${name}.${key} must be a string.`);
          }
        }
        if (providerConfig.type === 'openai' && (typeof providerConfig.apiKey !== 'string' || providerConfig.apiKey.trim() === '')) {
          throw new Error(`providers.llm.${name}.apiKey must be a non-empty string.`);
        }
      }
    }
    const embedding = config.embedding;
    if (embedding !== undefined) {
      if (!embedding || typeof embedding !== 'object' || Array.isArray(embedding)) {
        throw new Error('providers.embedding must be an object if provided.');
      }
      for (const [name, section] of Object.entries(embedding as Record<string, unknown>)) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
          throw new Error(`providers.embedding.${name} must be an object.`);
        }

        const providerConfig = section as Record<string, unknown>;
        if (typeof providerConfig.type !== 'string' || providerConfig.type.trim() === '') {
          throw new Error(`providers.embedding.${name}.type must be a non-empty string.`);
        }
        for (const key of ['type', 'model', 'apiKey', 'baseUrl']) {
          const value = providerConfig[key];
          if (value !== undefined && typeof value !== 'string') {
            throw new Error(`providers.embedding.${name}.${key} must be a string.`);
          }
        }
        if (providerConfig.type === 'openai' && (typeof providerConfig.apiKey !== 'string' || providerConfig.apiKey.trim() === '')) {
          throw new Error(`providers.embedding.${name}.apiKey must be a non-empty string.`);
        }
        if (
          providerConfig.dimensions !== undefined &&
          (!Number.isInteger(providerConfig.dimensions) || (providerConfig.dimensions as number) <= 0)
        ) {
          throw new Error(`providers.embedding.${name}.dimensions must be a positive integer.`);
        }
      }
    }
  }

  if (root.semanticIndex !== undefined) {
    throw new Error('semanticIndex is no longer supported; use extractor.embeddingProvider instead.');
  }

  const watchdog = root.watchdog;
  if (watchdog !== undefined) {
    if (!watchdog || typeof watchdog !== 'object' || Array.isArray(watchdog)) {
      throw new Error('watchdog must be an object if provided.');
    }

    const config = watchdog as Record<string, unknown>;
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      throw new Error('watchdog.enabled must be a boolean.');
    }
    for (const key of ['intervalMs', 'compactMinFragments']) {
      const value = config[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
        throw new Error(`watchdog.${key} must be a positive integer.`);
      }
    }

    const extractionConfig = config.extraction;
    if (extractionConfig !== undefined) {
      if (
        !extractionConfig ||
        typeof extractionConfig !== 'object' ||
        Array.isArray(extractionConfig)
      ) {
        throw new Error('watchdog.extraction must be an object if provided.');
      }

      const nested = extractionConfig as Record<string, unknown>;
      for (const key of ['targetPartitionSize', 'optimizeMergeCount']) {
        const value = nested[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
          throw new Error(`watchdog.extraction.${key} must be a positive integer.`);
        }
      }
    }
  }
}
