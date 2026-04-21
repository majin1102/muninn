import { mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { pluginRoot, resolveOpenClawRoot } from "./paths.mjs";

const openclawLinkDir = path.join(pluginRoot, "node_modules");
const openclawLinkPath = path.join(openclawLinkDir, "openclaw");
const piAiLinkDir = path.join(pluginRoot, "node_modules", "@mariozechner");
const piAiLinkPath = path.join(piAiLinkDir, "pi-ai");
const piCodingAgentLinkPath = path.join(piAiLinkDir, "pi-coding-agent");

export async function ensureOpenClawPackageLink(options = {}) {
  const openclawRoot = resolveOpenClawRoot();
  const openclawSelfLinkDir = path.join(openclawRoot, "node_modules");
  const openclawSelfLinkPath = path.join(openclawSelfLinkDir, "openclaw");
  const openclawLink = await ensureLink(openclawLinkDir, openclawLinkPath, openclawRoot);
  const openclawSelfLink = options.selfLink === true
    ? await ensureLink(openclawSelfLinkDir, openclawSelfLinkPath, openclawRoot)
    : { created: false, cleanup: async () => undefined };
  const piAiLink = await ensureLink(
    piAiLinkDir,
    piAiLinkPath,
    path.join(openclawRoot, "node_modules", "@mariozechner", "pi-ai"),
  );
  const piCodingAgentLink = await ensureLink(
    piAiLinkDir,
    piCodingAgentLinkPath,
    path.join(openclawRoot, "node_modules", "@mariozechner", "pi-coding-agent"),
  );

  return {
    created:
      openclawLink.created
      || openclawSelfLink.created
      || piAiLink.created
      || piCodingAgentLink.created,
    cleanup: async () => {
      await piCodingAgentLink.cleanup();
      await piAiLink.cleanup();
      await openclawSelfLink.cleanup();
      await openclawLink.cleanup();
    },
  };
}

async function ensureLink(linkDir, linkPath, targetPath) {
  await mkdir(linkDir, { recursive: true });

  const expectedRealPath = await realpath(targetPath);
  try {
    const currentTarget = await readlink(linkPath);
    const currentRealPath = await realpath(path.resolve(linkDir, currentTarget));
    if (currentRealPath !== expectedRealPath) {
      throw new Error(`existing openclaw link points to ${currentRealPath}`);
    }
    return { created: false, cleanup: async () => undefined };
  } catch (error) {
    if (isMissing(error)) {
      await symlink(targetPath, linkPath, "dir");
      return {
        created: true,
        cleanup: async () => {
          await rm(linkPath, { recursive: true, force: true });
        },
      };
    }
    if (isNotSymlink(error)) {
      const currentRealPath = await realpath(linkPath);
      if (currentRealPath === expectedRealPath) {
        return { created: false, cleanup: async () => undefined };
      }
      throw new Error(`existing openclaw path resolves to ${currentRealPath}`);
    }
    throw error;
  }
}

function isMissing(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isNotSymlink(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EINVAL");
}
