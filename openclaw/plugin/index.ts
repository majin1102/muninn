import { definePluginEntry } from "openclaw/plugin-sdk/core";

import { registerMuninnHooks } from "./src/hooks.js";
import { resolvePluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "muninn",
  name: "Muninn",
  description: "Muninn memory integration for OpenClaw",
  register(api) {
    registerMuninnHooks(api);
    const config = resolvePluginConfig(api.pluginConfig);
    if (config?.enabled) {
      api.logger.info?.(
        "muninn: registered hook-based writes with hook-based recall injection"
      );
    }
  },
});
