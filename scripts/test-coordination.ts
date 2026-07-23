import { canRunJobsInParallel, estimateToolSchemaTokens } from "../src/agent/delegation";
import { fileRevision } from "../src/agent/tools/util";

let failures = 0;
function assert(value: boolean, label: string) {
  if (value) console.log("  ✓ " + label);
  else { console.error("  ✗ " + label); failures++; }
}

console.log("Scoped delegation:");
assert(canRunJobsInParallel([
  { task: "a", paths: ["src/a.ts"] },
  { task: "b", paths: ["src/b.ts"] },
]), "disjoint files may run in parallel");
assert(!canRunJobsInParallel([
  { task: "a", paths: ["src/"] },
  { task: "b", paths: ["src/b.ts"] },
]), "directory/file overlap is serialized");
assert(!canRunJobsInParallel([
  { task: "a" },
  { task: "b", paths: ["src/b.ts"] },
]), "unscoped jobs are serialized");

console.log("Revision and schema telemetry:");
assert(fileRevision("same") === fileRevision(Buffer.from("same")), "string and bytes produce the same revision");
assert(fileRevision("before") !== fileRevision("after"), "content changes alter revision");
assert(estimateToolSchemaTokens([]) === 1, "empty schema has a stable minimal estimate");

if (failures) process.exit(1);
console.log("\nAll coordination guarantees hold. ✓");
