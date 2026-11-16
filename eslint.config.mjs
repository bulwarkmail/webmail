import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        React: "readonly",
        JSX: "readonly",
        NodeJS: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },
  {
    // Node-only build tooling (Bulwark Lite pipeline).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["lib/email-dark-mode-engine.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
      // bulwarkmail/native embeds this file as a String.raw string that the
      // WebView evaluates, so it stays ES5 (the export line is stripped there)
      // and no string may hold a backtick or "${".
      "no-restricted-syntax": [
        "error",
        ...[
          "ArrowFunctionExpression", "TemplateLiteral", "TaggedTemplateExpression", "ClassDeclaration", "ClassExpression",
          "VariableDeclaration[kind!='var']", "SpreadElement", "RestElement", "ObjectPattern", "ArrayPattern",
          "AssignmentPattern", "ForOfStatement", "Property[shorthand=true]", "Property[method=true]",
          "Property[computed=true]", "AwaitExpression", "YieldExpression", "FunctionDeclaration[async=true]",
          "FunctionExpression[async=true]", "FunctionDeclaration[generator=true]", "FunctionExpression[generator=true]",
          "ChainExpression", "LogicalExpression[operator='??']", "BinaryExpression[operator='**']",
          "AssignmentExpression[operator=/^(\\*\\*|\\?\\?|&&|\\|\\|)=$/]", "MetaProperty", "ImportDeclaration",
          "ImportExpression", "ExportNamedDeclaration", "Literal[bigint]",
        ].map((selector) => ({ selector, message: "lib/email-dark-mode-engine.js must stay ES5 for bulwarkmail/native." })),
        { selector: "Literal[raw=/`|\\$\\{/]", message: "bulwarkmail/native embeds this file in a String.raw template: no backtick or \"${\"." },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly",
        test: "readonly",
      },
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "repos/**",
      "data/admin/plugins/**",
      "public/**/*.js",
      "*.config.js",
      "*.config.mjs",
      "local-data/**",
      "benchmark/**",
      "examples/**",
      "integration/**",
      "scripts/a11y-guard/axe.min.js",
      "vendor/**",
    ],
  },
];
