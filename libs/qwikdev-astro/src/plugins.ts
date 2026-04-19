import { qwikVite } from "@qwik.dev/core/optimizer";
import type { QwikManifest, QwikVitePluginOptions } from "@qwik.dev/core/optimizer";
import type { InlineConfig, PluginOption } from "vite";
import { build } from "vite";

import { SERVER_ENTRYPOINT, VIRTUAL_MODULES } from "./constants";

/** Intercepts `@qwik-client-manifest` to provide the manifest from our standalone Qwik client build. */
export function createQwikManifestPlugin(
  getManifest: () => QwikManifest | null
): PluginOption {
  const virtualId = VIRTUAL_MODULES["@qwik-client-manifest"];

  return {
    name: "astro-qwik-manifest",
    enforce: "pre",
    resolveId(id) {
      if (id === "@qwik-client-manifest") return virtualId;
      return undefined;
    },
    load(id) {
      if (id !== virtualId) return undefined;
      const manifest = getManifest();
      return {
        code: `export const manifest = ${manifest ? JSON.stringify(manifest) : "undefined"};`,
        moduleSideEffects: false
      };
    }
  };
}

/** Strips qwikVite's outputOptions hook so the standalone Qwik client build handles client output instead. */
export function stripOutputOptions(plugins: PluginOption[]) {
  for (const plugin of plugins) {
    if (plugin && typeof plugin === "object" && "outputOptions" in plugin) {
      delete plugin.outputOptions;
    }
  }
}
/**
 * Filters Astro's vite plugins down to those safe/needed for the standalone
 * Qwik client build (ssr: false, browser target).
 *
 * Uses a strict allowlist — only plugins explicitly known to be browser-safe
 * and required for the inner client build pass through. The previous blocklist
 * approach let server-only plugins (rollup, tsx, jiti, fdir, tinyglobby, etc.)
 * leak into the browser-target Rollup build, causing hard UNRESOLVED_IMPORT
 * errors (e.g. fsevents on Linux) and MISSING_EXPORT errors (node:fs/promises
 * via astro-content-virtual-mod-plugin) that cannot be suppressed from user
 * config because runQwikClientBuild does not propagate build.rollupOptions.
 *
 * Vite's built-in plugins (vite:css, vite:resolve, etc.) are automatically
 * added by vite.build() and do NOT need to be listed here.
 *
 * To add a new plugin to the inner build, add its exact name to ALLOWED.
 */
export function filterAstroPlugins(plugins: PluginOption[]): PluginOption[] {
  // No Astro plugins are safe/needed for the inner Qwik client browser build.
  //
  // Tested Astro plugins and why each is excluded:
  //   "astro:tsconfig-alias"  — uses @rollup/pluginutils → rollup → fsevents (macOS-only)
  //   "astro:transitions"     — imports astro/dist/core/compile/compile-rs.js
  //                             which requires @astrojs/compiler-rs (Rust native addon)
  //
  // Path aliases are already provided via the resolve config propagated from
  // astroViteConfig. Virtual modules (virtual:image-service, virtual:uno.css,
  // virtual:astro/*, etc.) are handled by the qwikdev-astro:virtual-browser-noop
  // plugin registered above.
  //
  // Vite's built-in plugins (vite:resolve, vite:css, etc.) are added automatically
  // by vite.build() and must NOT appear here. The qwikVite() plugin handles all
  // Qwik-specific compilation and optimisation for the browser target.
  const ALLOWED = new Set<string>();

  return (plugins?.flatMap((p) => (Array.isArray(p) ? p : [p])) ?? [])
    .filter((plugin): plugin is { name: string } & NonNullable<PluginOption> => {
      return plugin != null && typeof plugin === "object" && "name" in plugin;
    })
    .filter((plugin) => ALLOWED.has(plugin.name));
}

/** Runs a standalone Qwik client build to generate the manifest before Astro's prerender. */
export async function runQwikClientBuild(opts: {
  entrypoints: Set<string>;
  rootEntry: string;
  srcDir: string;
  serverDir: string;
  finalDir: string;
  debug: boolean;
  onManifest: (manifest: QwikManifest) => void;
  astroViteConfig: InlineConfig;
}) {
  const config: QwikVitePluginOptions = {
    srcDir: opts.srcDir,
    ssr: {
      input: SERVER_ENTRYPOINT,
      outDir: opts.serverDir
    },
    client: {
      input: [...opts.entrypoints, opts.rootEntry],
      outDir: opts.finalDir,
      manifestOutput: opts.onManifest
    },
    debug: opts.debug
  };

  const astroPlugins = filterAstroPlugins(
    (opts.astroViteConfig.plugins as PluginOption[]) ?? []
  );

  const { root, resolve } = opts.astroViteConfig;

  await build({
    ...(root ? { root } : {}),
    ...(resolve ? { resolve } : {}),
    plugins: [
      // Astro registers virtual modules (virtual:image-service, virtual:astro/*,
      // virtual:uno.css, etc.) via its plugin chain. That plugin chain is NOT present
      // in this inner browser build (it was filtered by filterAstroPlugins).
      // Without this plugin, any Astro core file that imports a virtual: module
      // causes an UNRESOLVED_IMPORT hard error in Vite 7's onRollupLog.
      // These modules have no meaning in a browser (ssr:false) context — Qwik's
      // resumability means only event handlers run in the browser, not the full
      // component tree including SSR-only code paths that reference virtual modules.
      {
        name: "qwikdev-astro:virtual-browser-noop",
        enforce: "pre" as const,
        resolveId(id: string) {
          if (id.startsWith("virtual:")) return "\0" + id;
          return undefined;
        },
        load(id: string) {
          if (id.startsWith("\0virtual:")) return "export default {};";
          return undefined;
        }
      },
      ...astroPlugins,
      qwikVite(config)
    ],
    build: {
      ssr: false,
      outDir: opts.finalDir,
      emptyOutDir: false
    }
  });
}

/** Undoes qwikVite's output dir overrides so Astro controls per-environment output directories. */
export function createAstroQwikPostPlugin(isDev: boolean): PluginOption {
  return {
    name: "astro-qwik-post",
    enforce: "post" as const,
    config(config) {
      config.esbuild = {};
      if (isDev) return config;

      delete config.build?.outDir;

      const output = config.build?.rollupOptions?.output;
      if (!output) return config;

      if (Array.isArray(output)) {
        for (const o of output) if (o && typeof o === "object") delete o.dir;
      } else if (typeof output === "object") {
        delete output.dir;
      }

      return config;
    }
  };
}
