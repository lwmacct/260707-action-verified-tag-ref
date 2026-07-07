import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { builtinModules } from "node:module";
import { minify } from "terser";

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((id) => (id.startsWith("node:") ? [id, id.slice(5)] : [id, `node:${id}`])),
);

const CHUNK_RULES = [
  ["actions-shared", { packages: ["@actions/core"], prefixes: ["@actions/"] }],
];

function manualChunks(id) {
  const packageName = packageNameFromId(id);
  if (!packageName) {
    return undefined;
  }

  return CHUNK_RULES.find(([, rule]) => matchesChunkRule(packageName, rule))?.[0] ?? "vendor";
}

function onLog(level, log, handler) {
  if (isThirdPartyCircularDependency(log) || isThirdPartyThisRewrite(log)) {
    return;
  }

  handler(level, log);
}

function isThirdPartyCircularDependency(log) {
  return log.code === "CIRCULAR_DEPENDENCY" && log.ids?.every((id) => packageNameFromId(id));
}

function isThirdPartyThisRewrite(log) {
  return log.code === "THIS_IS_UNDEFINED" && packageNameFromId(log.id ?? log.loc?.file ?? "");
}

function packageNameFromId(id) {
  const normalizedId = id.replace(/\\/g, "/");
  const nodeModulesIndex = normalizedId.lastIndexOf("/node_modules/");
  if (nodeModulesIndex === -1) {
    return undefined;
  }

  const packagePath = normalizedId.slice(nodeModulesIndex + "/node_modules/".length);
  const [scopeOrName, name] = packagePath.split("/");
  if (!scopeOrName) {
    return undefined;
  }

  return scopeOrName.startsWith("@") && name ? `${scopeOrName}/${name}` : scopeOrName;
}

function matchesChunkRule(packageName, rule) {
  return (
    rule.packages?.includes(packageName) ||
    rule.prefixes?.some((prefix) => packageName.startsWith(prefix)) ||
    false
  );
}

function minifyDependencyChunks() {
  return {
    name: "minify-dependency-chunks",
    async renderChunk(code, chunk) {
      if (!chunk.fileName.startsWith("chunks/")) {
        return null;
      }

      const result = await minify(code, {
        compress: {
          passes: 2,
        },
        format: {
          comments: false,
        },
        mangle: true,
        module: true,
      });

      if (!result.code) {
        throw new Error(`Failed to minify ${chunk.fileName}`);
      }

      return {
        code: result.code,
        map: null,
      };
    },
  };
}

export default {
  input: "src/main.ts",
  external: (id) => NODE_BUILTINS.has(id),
  onLog,
  output: {
    dir: "dist",
    format: "es",
    entryFileNames: "index.js",
    chunkFileNames: "chunks/[name].js",
    manualChunks,
    generatedCode: {
      constBindings: true,
    },
  },
  plugins: [
    nodeResolve({
      exportConditions: ["node", "import", "default"],
      preferBuiltins: true,
    }),
    commonjs({
      transformMixedEsModules: true,
    }),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
      noForceEmit: true,
      noEmit: false,
      outDir: undefined,
    }),
    minifyDependencyChunks(),
  ],
};
