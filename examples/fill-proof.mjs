/**
 * Fill the "Verified transactions" table in PROOF.md from proof/paid-calls.jsonl.
 *
 * After running `npm run selfpay` for one or more endpoints, run this to
 * regenerate the table rows. It takes the most recent record per endpoint, so
 * re-running after every selfpay call is safe and idempotent.
 *
 *   node examples/fill-proof.mjs        # or: npm run proof
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const jsonlPath = path.join(root, "proof", "paid-calls.jsonl");
const proofPath = path.join(root, "PROOF.md");

// Fixed table shape: endpoint key -> display row.
const ROWS = [
  { key: "gas", ep: "`GET /v1/gas`", tier: "standard", price: "$0.001" },
  { key: "history", ep: "`GET /v1/history`", tier: "premium", price: "$0.01" },
  { key: "estimate", ep: "`POST /v1/estimate`", tier: "premium", price: "$0.01" },
];

// Most recent record per endpoint.
const byEp = {};
if (fs.existsSync(jsonlPath)) {
  for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const r = JSON.parse(s);
    const tx = r.settlement?.transaction ?? r.transaction ?? null;
    const buyer = r.authorization?.from ?? null;
    byEp[r.endpoint] = { tx, buyer };
  }
}

const dataRows = ROWS.map((row) => {
  const rec = byEp[row.key];
  const tx = rec?.tx ?? null;
  const buyer = rec?.buyer ?? null;
  const txCell = tx ?? "_(run `npm run selfpay`)_";
  const buyerCell = buyer ?? "";
  return `| ${row.ep} | ${row.tier} | ${row.price} | ${txCell} | ${buyerCell} |`;
});

const proof = fs.readFileSync(proofPath, "utf8").split("\n");
const headerIdx = proof.findIndex((l) => l.startsWith("| Endpoint |"));
if (headerIdx === -1) {
  console.error("Could not find the transactions table in PROOF.md");
  process.exit(1);
}
const sepIdx = headerIdx + 1;
if (!/^\|[\s:|-]+\|$/.test(proof[sepIdx] ?? "")) {
  console.error("Unexpected table layout in PROOF.md (header not followed by separator)");
  process.exit(1);
}
// Keep header + separator, replace the data rows that follow.
const newProof = [
  ...proof.slice(0, sepIdx + 1),
  ...dataRows,
  ...proof.slice(sepIdx + 1 + ROWS.length),
];
fs.writeFileSync(proofPath, newProof.join("\n"));

console.log("PROOF.md table updated:");
for (const r of dataRows) console.log(r);
const missing = ROWS.filter((row) => !byEp[row.key]).map((row) => row.key);
if (missing.length) console.log(`\nStill missing (run \`npm run selfpay\` with QUOTE_ENDPOINT=): ${missing.join(", ")}`);
