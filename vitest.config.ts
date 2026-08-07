import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    passWithNoTests: true,
    exclude: ["tests/**", "node_modules/**"],
  },
});
