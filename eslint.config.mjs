import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "data.json"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["esbuild.config.mjs", "eslint.config.mjs"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
