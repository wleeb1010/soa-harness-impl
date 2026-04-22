// Ad-hoc script: fetch /audit/records from :7700 and validate the
// response body against audit-records-response.schema.json.
import { registry } from "../packages/schemas/dist/index.js";

const bearer = process.argv[2];
if (!bearer) {
  console.error("usage: node scripts/validate-audit.mjs <session-bearer>");
  process.exit(2);
}
const resp = await fetch("http://127.0.0.1:7700/audit/records?limit=50", {
  headers: { authorization: `Bearer ${bearer}` }
});
const body = await resp.json();
const validate = registry["audit-records-response"];
const ok = validate(body);
console.log(
  JSON.stringify(
    {
      records_count: body.records?.length ?? 0,
      has_more: body.has_more,
      schema_valid: ok,
      schema_errors: ok ? null : validate.errors
    },
    null,
    2
  )
);
if (body.records?.length) {
  console.log("first record:", JSON.stringify(body.records[0], null, 2));
}
