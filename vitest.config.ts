import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@akb/core": `${root}packages/core/src/index.ts`,
      "@akb/confidence": `${root}packages/confidence/src/index.ts`,
      "@akb/git-store": `${root}packages/git-store/src/index.ts`,
      "@akb/markdown-engine": `${root}packages/markdown-engine/src/index.ts`,
      "@akb/ranker": `${root}packages/ranker/src/index.ts`,
      "@akb/search-engine": `${root}packages/search-engine/src/index.ts`,
      "@akb/eval-harness": `${root}packages/eval-harness/src/index.ts`,
      "@akb/mcp-server": `${root}apps/mcp-server/src/server.ts`,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["apps/cli/src/main.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
