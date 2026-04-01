import { definePluginEntry } from "openclaw/plugin-sdk/core";

import { registerMuninnHooks } from "./src/hooks.js";
import { createMuninnContextEngine } from "./src/context-engine.js";
import { resolvePluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "muninn",
  name: "Muninn",
  description: "Muninn memory integration for OpenClaw",
  kind: "memory",
  register(api) {
    registerMuninnHooks(api);

    if (typeof api.registerContextEngine === "function") {
      const config = resolvePluginConfig(api.pluginConfig);
      if (config?.enabled) {
        api.registerContextEngine("muninn", () =>
          createMuninnContextEngine({
            config,
            logger: api.logger,
          })
        );
        api.logger.info?.(
          "muninn: registered context-engine (assemble=global-recency) with hook-based writes"
        );
      }
    } else {
      api.logger.warn?.(
        "muninn: registerContextEngine unavailable; only hooks will run"
      );
    }
  },
});
