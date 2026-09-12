import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        // src/core/types.ts is a type-only module: it erases to zero runtime
        // JS, so v8 would report 0/0 for it and average it in as literal 0%,
        // failing the global thresholds. Same documented policy as pi-weave's
        // src/core/view/types.ts exclusion.
        "src/core/types.ts",
      ],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      reporter: ["text", "html"],
    },
  },
});