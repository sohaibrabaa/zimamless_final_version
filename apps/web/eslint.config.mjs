import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Money is never a JS number (brief §5 / Master Plan 5.5): the API sends
    // decimal strings like "1250.000". parseFloat/parseInt truncate precision
    // and Number() on a money string produces a float. Use lib/money.ts instead.
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money values are decimal strings — use parseMoney() from @/lib/money instead of parseFloat." },
        { name: "parseInt", message: "Money values are decimal strings — use parseMoney() from @/lib/money instead of parseInt." },
      ],
      // no-restricted-globals only matches bare identifiers, so the member
      // forms (Number.parseFloat, globalThis.parseInt) walked straight past
      // it. These selectors close that door.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='Number'][arguments.0.type!='Literal']",
          message: "Do not coerce values to Number for money math — use parseMoney()/Decimal from @/lib/money.",
        },
        {
          selector:
            "MemberExpression[object.name=/^(Number|globalThis|window|global)$/][property.name=/^(parseFloat|parseInt)$/]",
          message: "Money values are decimal strings — use parseMoney() from @/lib/money.",
        },
        {
          selector:
            "MemberExpression[object.name=/^(globalThis|window|global)$/][property.name='Number']",
          message: "Do not coerce values to Number for money math — use parseMoney()/Decimal from @/lib/money.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated files — never hand-edited.
    "public/mockServiceWorker.js",
    "lib/api/generated/**",
  ]),
]);

export default eslintConfig;
