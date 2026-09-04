import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  reactRefresh.configs.vite,
  {
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // This task, section 30: `import.meta.env` must only ever be read inside the centralized
      // env module — every other file reads the already-validated, typed `env` export instead.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
          message:
            "Do not access import.meta.env directly — import { env } from '@/lib/env' instead.",
        },
      ],
    },
  },
  {
    // The one file allowed to read import.meta.env (this task, section 29/30).
    files: ["src/lib/env.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Generated/adapted shadcn primitives (this task, section 67) — several export a component
    // alongside a plain `cva()` variants function (e.g. `Button`/`buttonVariants`), a standard
    // shadcn pattern that `react-refresh/only-export-components` otherwise flags. Never edited
    // by hand beyond what `shadcn add` itself generates, so linted more leniently than
    // application code.
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  eslintConfigPrettier,
);
