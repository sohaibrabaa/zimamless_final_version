// Merges the frozen base contract (docs/03_API_CONTRACT.yaml) with the
// approved additive overlay (docs/amendments/API_v3.1.0_OVERLAY.yaml) into
// one OpenAPI document, per Master Plan 3.4 #1: "Agent B merges this
// overlay with the base file before generating its client and mocks."
//
// Never edit docs/03_API_CONTRACT.yaml directly (frozen) — regenerate this
// merge, and the typed client + MSW handlers, whenever the overlay changes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const basePath = path.join(repoRoot, "docs", "03_API_CONTRACT.yaml");
const overlayPath = path.join(repoRoot, "docs", "amendments", "API_v3.1.0_OVERLAY.yaml");
const outDir = path.join(here, "..", "lib", "api", "generated");
const outPath = path.join(outDir, "openapi.merged.yaml");

const base = yaml.load(readFileSync(basePath, "utf8"));
const overlay = yaml.load(readFileSync(overlayPath, "utf8"));

// Overlay refs are written as '03_API_CONTRACT.yaml#/components/schemas/X'
// (relative to docs/amendments/ where the standalone overlay file lives).
// Once merged into one document those become local refs.
function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.includes("03_API_CONTRACT.yaml#")) {
        out[key] = value.slice(value.indexOf("#"));
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

const overlayPaths = rewriteRefs(overlay.paths ?? {});
const overlaySchemas = rewriteRefs(overlay.components?.schemas ?? {});

for (const p of Object.keys(overlayPaths)) {
  if (base.paths[p]) {
    throw new Error(`Overlay path collides with a frozen path: ${p} — this is a contract violation, stop and raise it.`);
  }
}
for (const s of Object.keys(overlaySchemas)) {
  if (base.components.schemas[s]) {
    throw new Error(`Overlay schema collides with a frozen schema: ${s} — this is a contract violation, stop and raise it.`);
  }
}

const merged = {
  ...base,
  info: { ...base.info, version: "3.1.0" },
  paths: { ...base.paths, ...overlayPaths },
  components: {
    ...base.components,
    schemas: { ...base.components.schemas, ...overlaySchemas },
  },
};

// D-10 (docs/coordination/DECISIONS.md): GET /auth/me gains an OPTIONAL
// `demo` block, present only when demo_time_machine_enabled=true. The
// overlay documents this as a comment (not structured YAML) since it
// patches an existing frozen response inline rather than adding a path.
const authMeResponseSchema =
  merged.paths["/auth/me"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
if (authMeResponseSchema) {
  authMeResponseSchema.properties.demo = {
    type: "object",
    description: "Present only when demo_time_machine_enabled=true (D-10); absent in production.",
    properties: {
      timeMachineEnabled: { type: "boolean" },
      currentOffsetDays: { type: "integer" },
    },
  };
} else {
  throw new Error("Could not locate GET /auth/me response schema to apply the D-10 patch — contract shape changed, raise it.");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, yaml.dump(merged, { noRefs: true, lineWidth: -1 }), "utf8");
console.log(`Merged contract written to ${path.relative(process.cwd(), outPath)}`);
