module.exports = {
  root: true,
  ignorePatterns: [
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
  overrides: [
    {
      files: [
        "apps/**/*.js",
        "apps/**/*.jsx",
        "packages/**/*.js",
        "packages/**/*.jsx",
      ],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      rules: {
        complexity: ["error", { max: 20 }],
      },
    },
  ],
};
