import eslintReact from "@eslint-react/eslint-plugin";
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Both plugins carry the React Compiler diagnostics under the same rule names,
// so without this list each one reports twice on the same line. React Compiler
// is left as the single source because it is the stricter of the two:
// @eslint-react's preset omits globals, immutability and refs altogether and
// reports purity and set-state-in-effect as warnings. The overlap is computed
// rather than written out, so a plugin release that mirrors one more rule
// cannot reintroduce the double report unnoticed. @eslint-react ships the
// mirror of this as "disable-conflict-eslint-plugin-react-hooks", which settles
// the clash the other way and takes those five with it.
const reactCompilerRules = new Set(Object.keys(reactHooks.rules));
const duplicatedByReactCompiler = Object.fromEntries(
  Object.keys(eslintReact.configs["recommended-type-checked"].rules)
    .filter((rule) => reactCompilerRules.has(rule.replace("@eslint-react/", "")))
    .map((rule) => [rule, "off"]),
);

// One config for the whole workspace. The parser globs below match whatever
// appears under apps/ and packages/ later, so a new package gets the base rules
// without an edit here, and a package's own `eslint .` walks up and finds this
// file. The two React blocks are the exception: tasma/web and
// tasma/web-fast-refresh each name apps/web, so a second React app or a React
// package needs both of those globs widened.
export default tseslint.config(
  { name: "tasma/ignores", ignores: ["**/dist/", "**/coverage/"] },
  // First, so that the typescript-eslint presets below can switch off the core
  // rules they replace. The typescript-eslint presets enable no core rule.
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  // Formatting lives in ESLint; this repository installs no separate formatter.
  {
    ...stylistic.configs.customize({
      indent: 2,
      quotes: "double",
      semi: true,
      commaDangle: "always-multiline",
      braceStyle: "1tbs",
      arrowParens: true,
    }),
    name: "tasma/formatting",
  },
  {
    name: "tasma/rules",
    rules: {
      // The preset default demands `interface`; this codebase declares types.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // avoidEscape leaves a single-quoted string alone when it contains a
      // double quote, which the task-format fixtures rely on.
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      // customize() sets no line width at all.
      "@stylistic/max-len": [
        "error",
        {
          code: 120,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
  {
    // An async fake with nothing to await, and an empty no-op callback, are
    // correct test code. The rule IDs must carry the plugin prefix: the presets
    // switch the base rules off and enable the typescript-eslint ones instead.
    //
    // no-unsafe-assignment is deliberately not relaxed here even though every
    // vitest asymmetric matcher is typed `any`: an untyped value crossing into
    // typed code is as much a defect in a test as in src. The four matcher
    // sites disable it inline instead.
    name: "tasma/tests",
    files: ["**/test/**"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    name: "tasma/web",
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [
      reactHooks.configs.flat.recommended,
      eslintReact.configs["recommended-type-checked"],
    ],
    rules: duplicatedByReactCompiler,
  },
  {
    // This block covers src alone. Fast Refresh constrains where a module may
    // sit for the dev server to hot-reload it. The dev server loads neither a
    // test module nor the build config, so the rule has nothing to say about
    // them.
    name: "tasma/web-fast-refresh",
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactRefresh.configs.vite],
  },
  {
    name: "tasma/type-aware",
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        // Explicit globs, not `projectService: true`. The project service only
        // discovers files named tsconfig.json, and every package here splits
        // src and tests across tsconfig.json and tsconfig.test.json. Under the
        // service every test file needs allowDefaultProject or a rename before
        // it parses at all; these globs reach both tsconfigs as they stand.
        project: [
          "tsconfig.json",
          "packages/*/tsconfig.json",
          "packages/*/tsconfig.test.json",
          "apps/*/tsconfig.json",
          "apps/*/tsconfig.test.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Last entry. An unscoped parser-options block placed after this one
    // re-applies type-aware parsing to JavaScript, and this config file then
    // stops linting itself.
    name: "tasma/js",
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
