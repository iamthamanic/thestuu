export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/.shim/**",
      "**/.shimwrapper/**",
      "**/.stryker-tmp/**",
      "**/.codex-home/**",
      "**/.venv-semgrep/**",
    ],
  },
  {
    files: ["apps/**/*.js", "apps/**/*.jsx", "packages/**/*.js", "packages/**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      complexity: ["error", { max: 20 }],
    },
  },
];
