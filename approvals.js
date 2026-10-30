// Human-approval queue. The AI agent can only PROPOSE actions; nothing with a side effect runs until a human approves.
import { collection } from "./store.js";
import crypto from "node:crypto";

const col = collection("approvals", "./approvals.json");
const store = col.data, flush = col.save;
const TTL = 48 * 3600e3; // proposals expire after 48h so stale approvals cannot be fired later
const err = (m, status) => Object.assign(new Error(m), { status });

export const executors = {}; // type -> async (payload, approval) => result

const strip = ({ secret, ...rest }) => rest; // "secret" is used only by executors, never sent to any client
export function propose({ caseId, type, summary, payload, approver = "owner", secret }) {
  const id = crypto.randomBytes(6).toString("hex");
  store[id] = { id, caseId, type, summary, payload, approver, secret, status: "PENDING", createdAt: Date.now() };
  flush();
  return strip(store[id]);
}
export const get = (id) => store[id];
export const list = (caseId) => Object.values(store).filter((a) => a.caseId === caseId).sort((a, b) => b.createdAt - a.createdAt).map(strip);
export const all = () => Object.values(store).map(strip);

export async function decide(id, approve, by) {
  const a = store[id];
  if (!a) throw err("Approval not found", 404);
  if (a.status !== "PENDING") throw err(`Already ${a.status}`, 409);
  if (Date.now() - a.createdAt > TTL) { a.status = "EXPIRED"; flush(); throw err("Approval expired; ask the agent to propose again", 410); }
  a.decidedBy = by; a.decidedAt = Date.now();
  if (!approve) { a.status = "REJECTED"; flush(); return strip(a); }
  a.status = "APPROVED"; flush(); // mark BEFORE running so a double-click cannot run it twice
  try { a.result = await executors[a.type](a.payload, a); a.status = "DONE"; }
  catch (e) { a.status = "FAILED"; a.error = e.message; }
  flush();
  return strip(a);
}
