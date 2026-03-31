import { definePluginEntry } from "openclaw/plugin-sdk/core";

import { registerMunnaiHooks } from "./src/hooks.js";
import { createMunnaiContextEngine } from "./src/context-engine.js";
import { resolvePluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "munnai",
  name: "Munnai",
  description: "Munnai memory integration for OpenClaw",
  kind: "memory",
  register(api) {
    registerMunnaiHooks(api);

    if (typeof api.registerContextEngine === "function") {
      const config = resolvePluginConfig(api.pluginConfig);
      if (config?.enabled) {
        api.registerContextEngine("munnai", () =>
          createMunnaiContextEngine({
            config,
            logger: api.logger,
          })
        );
        api.logger.info?.(
          "munnai: registered context-engine (assemble=global-recency) with hook-based writes"
        );
      }
    } else {
      api.logger.warn?.(
        "munnai: registerContextEngine unavailable; only hooks will run"
      );
    }
  },
});
