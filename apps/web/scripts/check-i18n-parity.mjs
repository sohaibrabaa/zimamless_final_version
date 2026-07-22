/**
 * RTL checklist rule #8: no message key may exist in only one locale.
 *
 * A key present in en.json but missing from ar.json doesn't fail loudly at
 * runtime — `useTranslations` falls back to returning the key itself, so the
 * Arabic screen quietly renders "onboarding.sla.pausedTitle" instead of text.
 * This makes that a build-time failure instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object"
      ? flatten(child, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

function keysOf(locale) {
  return new Set(flatten(JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), "utf8"))));
}

const en = keysOf("en");
const ar = keysOf("ar");

const missingInAr = [...en].filter((k) => !ar.has(k));
const missingInEn = [...ar].filter((k) => !en.has(k));

if (missingInAr.length || missingInEn.length) {
  if (missingInAr.length) {
    console.error(`Missing from messages/ar.json (${missingInAr.length}):`);
    for (const key of missingInAr) console.error(`  ${key}`);
  }
  if (missingInEn.length) {
    console.error(`Missing from messages/en.json (${missingInEn.length}):`);
    for (const key of missingInEn) console.error(`  ${key}`);
  }
  process.exit(1);
}

console.log(`i18n parity OK — ${en.size} keys in both locales.`);
