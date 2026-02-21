#!/usr/bin/env node
/**
 * i18n check: Ensures all translation keys used in code exist in every locale.
 * Scans source for useTranslations("namespace") and t/tNs("key"), compares to messages/*.json.
 * Usage: node scripts/i18n-check.js [--fix] [--messages-dir PATH]
 *   --fix: Add missing keys to locale files (value from fallback or "[key]").
 *   --messages-dir: Path to messages dir (default: dashboard/messages or ./messages).
 * Exit: 0 if all keys present in all locales; 1 if missing keys (or on error).
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.env.ROOT_DIR || path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const fix = args.includes("--fix");
const messagesDirArg = args.find((a) => a.startsWith("--messages-dir="));
const MESSAGES_DIR = messagesDirArg
  ? path.resolve(ROOT, messagesDirArg.replace("--messages-dir=", ""))
  : (() => {
      const candidates = [
        path.join(ROOT, "apps", "dashboard", "messages"),
        path.join(ROOT, "dashboard", "messages"),
        path.join(ROOT, "messages"),
      ];
      const found = candidates.find((d) => fs.existsSync(d));
      return found || candidates[0];
    })();

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length > 0
    ) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function setNested(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === "__proto__" || p === "prototype" || p === "constructor") {
      throw new Error(`unsafe key path segment: ${p}`);
    }
    if (!(p in cur) || typeof cur[p] !== "object") cur[p] = {};
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (last === "__proto__" || last === "prototype" || last === "constructor") {
    throw new Error(`unsafe key path segment: ${last}`);
  }
  cur[parts[parts.length - 1]] = value;
}

function collectSourceFiles(
  dir,
  exts = [".tsx", ".ts", ".jsx", ".js"],
  exclude = ["node_modules", ".next", "dist"],
) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = dir.endsWith(path.sep) ? `${dir}${e.name}` : `${dir}${path.sep}${e.name}`;
    if (e.isDirectory()) {
      if (!exclude.includes(e.name))
        results.push(...collectSourceFiles(full, exts, exclude));
    } else if (exts.some((ext) => e.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * In file content: find const t = useTranslations("namespace"); then find t("key") -> namespace.key.
 */
function extractUsedKeys(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const used = new Set();

  // const t = useTranslations("common") or let tChecks = useTranslations("checks")
  const nsByVar = {};
  const assignRegex =
    /(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = assignRegex.exec(content)) !== null) {
    nsByVar[m[1]] = m[2];
  }

  // t("key") or t('key') or tChecks("aiReview.label")
  const tCallRegex = /\b(t[A-Za-z0-9]*)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = tCallRegex.exec(content)) !== null) {
    const varName = m[1];
    const key = m[2];
    const namespace = nsByVar[varName];
    if (namespace) {
      used.add(`${namespace}.${key}`);
    }
  }

  return used;
}

function loadLocaleKeys(localePath) {
  const raw = fs.readFileSync(localePath, "utf8");
  const data = JSON.parse(raw);
  return { raw, data, flat: flatten(data) };
}

function main() {
  const sourceDirs = [
    path.join(ROOT, "apps"),
    path.join(ROOT, "packages"),
    path.join(ROOT, "apps", "dashboard"),
    path.join(ROOT, "dashboard"),
    path.join(ROOT, "app"),
    path.join(ROOT, "src"),
    path.join(ROOT, "components"),
  ].filter((d) => fs.existsSync(d));
  if (sourceDirs.length === 0) sourceDirs.push(ROOT);

  const allUsed = new Set();
  for (const dir of sourceDirs) {
    for (const file of collectSourceFiles(dir)) {
      try {
        for (const key of extractUsedKeys(file)) {
          allUsed.add(key);
        }
      } catch (err) {
        console.warn("i18n-check: skip", file, err.message);
      }
    }
  }

  if (!fs.existsSync(MESSAGES_DIR)) {
    if (allUsed.size === 0) {
      console.log(
        `i18n-check: messages dir not found (${MESSAGES_DIR}), but no i18n key usage detected; skipping.`,
      );
      process.exit(0);
    }
    console.error("i18n-check: messages dir not found:", MESSAGES_DIR);
    process.exit(1);
  }

  const localeFiles = fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".json"));
  if (localeFiles.length === 0) {
    if (allUsed.size === 0) {
      console.log(
        `i18n-check: no locale files in ${MESSAGES_DIR}, but no i18n key usage detected; skipping.`,
      );
      process.exit(0);
    }
    console.error("i18n-check: no *.json in", MESSAGES_DIR);
    process.exit(1);
  }

  const locales = {};
  for (const f of localeFiles) {
    const localePath = path.join(MESSAGES_DIR, f);
    locales[f] = loadLocaleKeys(localePath);
  }

  const fallbackLocale = "en.json";
  const fallbackFlat = locales[fallbackLocale]
    ? locales[fallbackLocale].flat
    : {};
  let hasMissing = false;
  const report = [];

  for (const [file, { data, flat }] of Object.entries(locales)) {
    const missing = [...allUsed].filter((k) => !(k in flat));
    if (missing.length) {
      hasMissing = true;
      report.push({ locale: file, missing });
      if (fix) {
        for (const key of missing) {
          const value = fallbackFlat[key] ?? `[${key}]`;
          setNested(data, key, value);
        }
        const outPath = path.join(MESSAGES_DIR, file);
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n", "utf8");
        report[report.length - 1].fixed = missing.length;
      }
    }
  }

  if (report.length) {
    for (const r of report) {
      console.log(`Locale: ${r.locale}`);
      console.log(`  Missing keys: ${r.missing.length}`);
      r.missing.slice(0, 20).forEach((k) => console.log(`    - ${k}`));
      if (r.missing.length > 20)
        console.log(`    ... and ${r.missing.length - 20} more`);
      if (r.fixed) console.log(`  Added ${r.fixed} keys (--fix).`);
    }
  }

  if (hasMissing && !fix) {
    console.error(
      "i18n-check FAIL: missing translation keys. Run with --fix to add placeholders.",
    );
    process.exit(1);
  }
  if (hasMissing && fix) {
    console.log("i18n-check: missing keys added. Please review and translate.");
    process.exit(0);
  }
  console.log("i18n-check OK: all used keys present in all locales.");
  process.exit(0);
}

main();
