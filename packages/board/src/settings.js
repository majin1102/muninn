"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSettingsJson = validateSettingsJson;
function validateSettingsJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('muninn.json must be a JSON object.');
    }
    const root = parsed;
    const storage = root.storage;
    if (storage !== undefined) {
        if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
            throw new Error('storage must be an object if provided.');
        }
        const config = storage;
        if (typeof config.uri !== 'string' || !config.uri.trim()) {
            throw new Error('storage.uri must be a non-empty string.');
        }
        const storageOptions = config.storageOptions;
        if (storageOptions !== undefined) {
            if (!storageOptions ||
                typeof storageOptions !== 'object' ||
                Array.isArray(storageOptions)) {
                throw new Error('storage.storageOptions must be an object if provided.');
            }
            for (const [key, value] of Object.entries(storageOptions)) {
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
        const config = turn;
        if (config.llm !== undefined && typeof config.llm !== 'string') {
            throw new Error('turn.llm must be a string.');
        }
        for (const key of ['llmSummaryThresholdChars', 'titleMaxChars']) {
            const value = config[key];
            if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
                throw new Error(`turn.${key} must be a positive integer.`);
            }
        }
    }
    const observer = root.observer;
    if (observer !== undefined) {
        if (!observer || typeof observer !== 'object' || Array.isArray(observer)) {
            throw new Error('observer must be an object if provided.');
        }
        const config = observer;
        for (const key of ['name', 'llm']) {
            const value = config[key];
            if (value !== undefined && typeof value !== 'string') {
                throw new Error(`observer.${key} must be a string.`);
            }
        }
        const maxAttempts = config.maxAttempts;
        if (maxAttempts !== undefined &&
            (!Number.isInteger(maxAttempts) || maxAttempts <= 0)) {
            throw new Error('observer.maxAttempts must be a positive integer.');
        }
        const activeWindowDays = config.activeWindowDays;
        if (activeWindowDays !== undefined &&
            (!Number.isInteger(activeWindowDays) || activeWindowDays <= 0)) {
            throw new Error('observer.activeWindowDays must be a positive integer.');
        }
    }
    const llm = root.llm;
    if (llm !== undefined) {
        if (!llm || typeof llm !== 'object' || Array.isArray(llm)) {
            throw new Error('llm must be an object if provided.');
        }
        for (const [name, section] of Object.entries(llm)) {
            if (!section || typeof section !== 'object' || Array.isArray(section)) {
                throw new Error(`llm.${name} must be an object.`);
            }
            const config = section;
            for (const key of ['provider', 'model', 'api', 'apiKey', 'baseUrl']) {
                const value = config[key];
                if (value !== undefined && typeof value !== 'string') {
                    throw new Error(`llm.${name}.${key} must be a string.`);
                }
            }
        }
    }
    const semanticIndex = root.semanticIndex;
    if (semanticIndex !== undefined) {
        if (!semanticIndex || typeof semanticIndex !== 'object' || Array.isArray(semanticIndex)) {
            throw new Error('semanticIndex must be an object if provided.');
        }
        const config = semanticIndex;
        const embedding = config.embedding;
        if (embedding !== undefined) {
            if (!embedding || typeof embedding !== 'object' || Array.isArray(embedding)) {
                throw new Error('semanticIndex.embedding must be an object if provided.');
            }
            const embeddingConfig = embedding;
            for (const key of ['provider', 'model', 'apiKey', 'baseUrl']) {
                const value = embeddingConfig[key];
                if (value !== undefined && typeof value !== 'string') {
                    throw new Error(`semanticIndex.embedding.${key} must be a string.`);
                }
            }
            if (embeddingConfig.dimensions !== undefined &&
                (!Number.isInteger(embeddingConfig.dimensions) || embeddingConfig.dimensions <= 0)) {
                throw new Error('semanticIndex.embedding.dimensions must be a positive integer.');
            }
        }
        if (config.defaultImportance !== undefined &&
            (typeof config.defaultImportance !== 'number' || Number.isNaN(config.defaultImportance))) {
            throw new Error('semanticIndex.defaultImportance must be a number.');
        }
    }
    const watchdog = root.watchdog;
    if (watchdog !== undefined) {
        if (!watchdog || typeof watchdog !== 'object' || Array.isArray(watchdog)) {
            throw new Error('watchdog must be an object if provided.');
        }
        const config = watchdog;
        if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
            throw new Error('watchdog.enabled must be a boolean.');
        }
        for (const key of ['intervalMs', 'compactMinFragments']) {
            const value = config[key];
            if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
                throw new Error(`watchdog.${key} must be a positive integer.`);
            }
        }
        const semanticIndexConfig = config.semanticIndex;
        if (semanticIndexConfig !== undefined) {
            if (!semanticIndexConfig ||
                typeof semanticIndexConfig !== 'object' ||
                Array.isArray(semanticIndexConfig)) {
                throw new Error('watchdog.semanticIndex must be an object if provided.');
            }
            const nested = semanticIndexConfig;
            for (const key of ['targetPartitionSize', 'optimizeMergeCount']) {
                const value = nested[key];
                if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
                    throw new Error(`watchdog.semanticIndex.${key} must be a positive integer.`);
                }
            }
        }
    }
}
