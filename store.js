// SQLite storage (built into Node 22.5+, no extra install). One file, transactional writes, WAL mode.
// Each collection is an in-memory object backed by a table row per document; save() writes only changed documents in one transaction.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const db = new DatabaseSync(process.env.DB_FILE || "./vend.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(coll,id))");
const upsert = db.prepare("INSERT INTO docs(coll,id,json) VALUES(?,?,?) ON CONFLICT(coll,id) DO UPDATE SET json=excluded.json");

export function collection(name, legacyJsonFile) {
  const data = {}, snap = {};
  for (const r of db.prepare("SELECT id,json FROM docs WHERE coll=?").all(name)) { data[r.id] = JSON.parse(r.json); snap[r.id] = r.json; }
  const save = () => {
    db.exec("BEGIN");
    try {
      for (const [id, d] of Object.entries(data)) { const j = JSON.stringify(d); if (snap[id] !== j) { upsert.run(name, id, j); snap[id] = j; } }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  // One-time import of data from the earlier JSON-file version.
  if (legacyJsonFile && !Object.keys(data).length && fs.existsSync(legacyJsonFile)) {
    Object.assign(data, JSON.parse(fs.readFileSync(legacyJsonFile, "utf8"))); save();
    fs.renameSync(legacyJsonFile, legacyJsonFile + ".imported");
  }
  return { data, save };
}
