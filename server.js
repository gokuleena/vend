// Vend escrow backend: Razorpay Route (held transfers) for India, INR only.
// Flow: create deal -> buyer pays -> money held -> buyer confirms (or hold expires) -> released to seller.
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import fs from "node:fs";
import { collection } from "./store.js";
import path from "node:path";
import { registerExtras } from "./extras.js";

const { RZP_KEY_ID, RZP_KEY_SECRET, RZP_WEBHOOK_SECRET, ADMIN_TOKEN } = process.env;
const FEE = Number(process.env.FEE_PERCENT ?? 2);
const HOLD_DAYS = Number(process.env.HOLD_DAYS ?? 3);
if (!RZP_KEY_ID || !RZP_KEY_SECRET || !RZP_WEBHOOK_SECRET || !ADMIN_TOKEN) {
  console.error("Missing env vars. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ---- storage: SQLite (see store.js) ----
const deals = collection("deals", "./deals.json");
const db = deals.data, save = deals.save;

// ---- helpers ----
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const basic = "Basic " + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");

async function rzp(path, method = "GET", body) {
  const r = await fetch((process.env.RZP_BASE || "https://api.razorpay.com") + (path.startsWith("/v2") ? "" : "/v1") + path, {
    method, headers: { Authorization: basic, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.description || "Razorpay error"), { status: r.status });
  return j;
}

const publicDeal = (d) => ({ id: d.id, type: d.type, title: d.title, amountInr: d.amountPaise / 100, status: d.status, holdUntil: d.holdUntil, deduction: d.deduction ? { amountInr: d.deduction.amountPaise / 100, reason: d.deduction.reason } : null });
const who = (d, req) => { // returns "buyer" | "seller" | null based on the bearer token
  const t = (req.get("authorization") || "").replace("Bearer ", "");
  if (!t) return null;
  if (safeEq(sha(t), d.buyerHash)) return "buyer";
  if (safeEq(sha(t), d.sellerHash)) return "seller";
  return null;
};
const adminOk = (req) => safeEq(req.get("x-admin-token"), ADMIN_TOKEN);
const admin = (req, res, next) => (adminOk(req) ? next() : res.sendStatus(401));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message }));
const load = (req, res) => { const d = db[req.params.id]; if (!d) { res.status(404).json({ error: "Deal not found" }); return null; } return d; };

const app = express();
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  scriptSrc: ["'self'", "https://checkout.razorpay.com"],
  frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  connectSrc: ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com"],
  imgSrc: ["'self'", "data:", "https://*.razorpay.com"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  ...(process.env.NODE_ENV === "production" ? {} : { upgradeInsecureRequests: null }),
} } }));
app.use(rateLimit({ windowMs: 60_000, limit: 60 }));

// ---- Razorpay webhook (needs the RAW body, so it is registered before express.json) ----
app.post("/webhooks/razorpay", express.raw({ type: "application/json" }), (req, res) => {
  if (!safeEq(hmac(RZP_WEBHOOK_SECRET, req.body), req.get("x-razorpay-signature"))) return res.sendStatus(400);
  const ev = JSON.parse(req.body.toString());
  const pay = ev.payload?.payment?.entity;
  const d = pay && db[pay.notes?.dealId] ;
  if (d && ["payment.captured", "order.paid"].includes(ev.event) && d.status === "AWAITING_PAYMENT") {
    d.status = "PAID_HELD"; d.paymentId = pay.id; save();
  }
  res.sendStatus(200); // always 200 quickly so Razorpay does not retry
});

app.get("/healthz", (req, res) => res.send("ok"));
registerExtras(app, { rzp, makeDeal, sha, safeEq, hmac, wrap, admin, db, save, who, adminOk });
app.use(express.json({ limit: "20kb" }));

// 1) Create a deal + Razorpay order. type "sale": seller share is a HELD transfer (auto-release after HOLD_DAYS).
//    type "deposit" (rental): held indefinitely, no fee; released/refunded only after a human decision.
async function makeDeal({ title, amountInr, sellerAccount, type = "sale" }) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const paise = Math.round(Number(amountInr) * 100);
  if (!title || !(paise >= 10000)) throw bad("title and amountInr (min 100) required");
  if (!/^acc_\w+$/.test(sellerAccount || "")) throw bad("valid seller linked account id required");
  const deposit = type === "deposit";
  const id = crypto.randomBytes(8).toString("hex");
  const holdUntil = Math.floor(Date.now() / 1000) + HOLD_DAYS * 86400;
  const sellerShare = deposit ? paise : paise - Math.round((paise * FEE) / 100);
  const order = await rzp("/orders", "POST", {
    amount: paise, currency: "INR", receipt: id, notes: { dealId: id },
    transfers: [{ account: sellerAccount, amount: sellerShare, currency: "INR", on_hold: 1, ...(deposit ? {} : { on_hold_until: holdUntil }), notes: { dealId: id } }],
  });
  const buyerToken = crypto.randomBytes(24).toString("hex");
  const sellerToken = crypto.randomBytes(24).toString("hex");
  db[id] = { id, type, title: String(title).slice(0, 120), amountPaise: paise, sellerShare, orderId: order.id, status: "AWAITING_PAYMENT",
    holdUntil: deposit ? null : holdUntil, buyerHash: sha(buyerToken), sellerHash: sha(sellerToken), createdAt: Date.now() };
  save();
  return { deal: publicDeal(db[id]), buyerToken, sellerToken, checkout: { keyId: RZP_KEY_ID, orderId: order.id, amount: paise, currency: "INR" } };
}
app.post("/api/deals", wrap(async (req, res) => res.json(await makeDeal(req.body))));

// 2) After Razorpay Checkout succeeds in the browser, verify the signature server-side.
app.post("/api/deals/:id/verify", wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (who(d, req) !== "buyer") return res.sendStatus(403);
  const { razorpay_payment_id, razorpay_signature } = req.body;
  if (!safeEq(hmac(RZP_KEY_SECRET, `${d.orderId}|${razorpay_payment_id}`), razorpay_signature)) return res.status(400).json({ error: "Bad signature" });
  if (d.status === "AWAITING_PAYMENT") { d.status = "PAID_HELD"; d.paymentId = razorpay_payment_id; save(); }
  res.json(publicDeal(d));
}));

app.get("/api/deals/:id", wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (!who(d, req)) return res.sendStatus(403);
  res.json(publicDeal(d));
}));

// Checkout details for the buyer's pay page (only while unpaid).
app.get("/api/deals/:id/checkout", wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (who(d, req) !== "buyer") return res.sendStatus(403);
  if (d.status !== "AWAITING_PAYMENT") return res.status(409).json({ error: `Status is ${d.status}` });
  res.json({ keyId: RZP_KEY_ID, orderId: d.orderId, amount: d.amountPaise, currency: "INR" });
}));

// Pages: owner inbox (/owner.html) and buyer pay page (/pay/:id?t=...)
app.use(express.static("public"));
app.get("/pay/:id", (req, res) => res.sendFile(path.resolve("public/pay.html")));

// Release = set on_hold to 0 on the order's transfer.
async function releaseFunds(d) {
  const o = await rzp(`/orders/${d.orderId}?expand[]=transfers`);
  const t = o.transfers?.items?.[0] ?? o.transfers?.[0];
  if (!t) throw Object.assign(new Error("Transfer not found yet (payment may not be captured)"), { status: 409 });
  await rzp(`/transfers/${t.id}`, "PATCH", { on_hold: 0 });
  d.transferId = t.id; d.status = "RELEASED"; save();
}
const setHold = async (d, on) => { await rzp(`/transfers/${d.transferId}`, "PATCH", { on_hold: on ? 1 : 0 }); };

// 3) Buyer confirms they received/checked the item -> money goes to the seller.
app.post("/api/deals/:id/confirm", wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (who(d, req) !== "buyer") return res.sendStatus(403);
  if (d.status !== "PAID_HELD") return res.status(409).json({ error: `Cannot confirm in status ${d.status}` });
  await releaseFunds(d); res.json(publicDeal(d));
}));

// 4) Buyer raises a dispute -> hold indefinitely until an admin decides.
app.post("/api/deals/:id/dispute", wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (who(d, req) !== "buyer") return res.sendStatus(403);
  if (d.status !== "PAID_HELD") return res.status(409).json({ error: `Cannot dispute in status ${d.status}` });
  if (!d.transferId) { const o = await rzp(`/orders/${d.orderId}?expand[]=transfers`); d.transferId = (o.transfers?.items?.[0] ?? o.transfers?.[0])?.id; }
  await setHold(d, true); d.status = "DISPUTED"; d.disputeNote = String(req.body.reason || "").slice(0, 500); save();
  res.json(publicDeal(d));
}));

// 5) Admin resolves a dispute: release to seller or refund the buyer.
app.post("/api/admin/deals/:id/resolve", admin, wrap(async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (d.status !== "DISPUTED") return res.status(409).json({ error: "Not disputed" });
  if (req.body.action === "release") await releaseFunds(d);
  else if (req.body.action === "refund") { await rzp(`/payments/${d.paymentId}/refund`, "POST", { reverse_all: 1 }); d.status = "REFUNDED"; save(); }
  else return res.status(400).json({ error: "action must be release or refund" });
  res.json(publicDeal(d));
}));

app.listen(process.env.PORT || 3000, () => console.log("Vend escrow backend running"));
