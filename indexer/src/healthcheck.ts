// The container healthcheck. Exits 0 when the indexer's checkpoint moved within
// the last minute, which it does on every step, one step a block.

import {closeDb, db} from "./db.ts";

const MAX_AGE_SECONDS = 60;

try {
  const r = await db().query("SELECT extract(epoch FROM now() - max(updated_at))::int AS age FROM indexer_state");
  const age = r.rows[0]?.age;
  await closeDb();
  process.exit(age !== null && age !== undefined && age <= MAX_AGE_SECONDS ? 0 : 1);
} catch {
  process.exit(1);
}
