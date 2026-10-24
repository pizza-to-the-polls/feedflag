// feedflag lint (house pattern: prettier + lint + tsc + test).
// typescript-eslint flat config — TS-aware without type-checked rules
// (tsc owns type errors; lint owns usage patterns).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["eslint.config.js", "data/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["src/**/*.ts", "scripts/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off", // CLI scripts log by design
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn", // scripts lean on any — warn, don't block
      "no-unused-expressions": "off",
    },
  },
);
