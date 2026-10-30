// Cases (a listing the owner runs), AI agent routes, approvals, WhatsApp inbound, seller onboarding, rental deposits.
import express from "express";
import crypto from "node:crypto";
import { collection } from "./store.js";
import * as A from "./approvals.js";
import * as conn from "./connectors.js";
import { runAgent } from "./agent.js";
import { provider as verifyProvider } from "./verification.js";

const vcol = collection("verifications");
const verifs = vcol.data;
const col = collection("cases", "./cases.json");
const cases = col.data, saveCases = col.save;

export function registerExtras(app, { rzp, makeDeal, sha, safeEq, hmac, wrap, admin, db, save, who, adminOk }) {
  const json = express.json({ limit: "20kb" });
  const bearer = (req) => (req.get("authorization") || "").replace("Bearer ", "");
  const ownerOf = (req, c) => safeEq(sha(bearer(req)), c.ownerHash);
  const getCase = (req, res) => { const c = cases[req.params.id]; if (!c) { res.status(404).json({ error: "Case not found" }); return null; } return c; };
  const ownerGuard = (req, res) => { const c = getCase(req, res); if (!c) return null; if (!ownerOf(req, c)) { res.sendStatus(403); return null; } return c; };

  // ---- Cases ----
  app.post("/api/cases", json, wrap(async (req, res) => {
    const { title, description, priceInr, floorInr, city, condition, sellerAccount } = req.body;
    if (!title || !(priceInr > 0)) return res.status(400).json({ error: "title and priceInr required" });
    const id = crypto.randomBytes(4).toString("hex"), ownerToken = crypto.randomBytes(24).toString("hex");
    cases[id] = { id, ownerHash: sha(ownerToken), sellerAccount: /^acc_\w+$/.test(sellerAccount || "") ? sellerAccount : null,
      item: { title: String(title).slice(0, 120), description: String(description || "").slice(0, 1000), priceInr, floorInr: floorInr || Math.round(priceInr * 0.85), city, condition },
      buyers: {}, phones: {} };
    saveCases();
    res.json({ caseId: id, ownerToken, whatsappRef: `Ref ${id}` }); // put "Ref <id>" in the prefilled WhatsApp text of every ad
  }));

  // Owner asks the agent to do something ("write the ad and propose where to post").
  app.post("/api/cases/:id/agent", json, wrap(async (req, res) => {
    const c = ownerGuard(req, res); if (!c) return;
    const propose = (p) => A.propose({ caseId: c.id, ...p });
    const out = await runAgent({ c, trigger: String(req.body.instruction || "Improve the listing, suggest a price, and propose 2-3 channels to post on.").slice(0, 500), propose, save: saveCases });
    res.json({ ...out, draft: c.draft });
  }));

  // ---- Approvals (the human gate) ----
  app.get("/api/cases/:id/approvals", wrap(async (req, res) => { const c = ownerGuard(req, res); if (c) res.json(A.list(c.id)); }));
  app.post("/api/approvals/:id/decide", json, wrap(async (req, res) => {
    const a = A.get(req.params.id); if (!a) return res.sendStatus(404);
    const c = cases[a.caseId];
    const isAdmin = adminOk(req), isOwner = c && ownerOf(req, c);
    if (!(isAdmin || (isOwner && a.approver === "owner"))) return res.sendStatus(403);
    res.json(await A.decide(a.id, req.body.approve === true, isAdmin ? "admin" : "owner"));
  }));

  // ---- Buyer conversations (owner) and admin views ----
  app.get("/api/cases/:id/buyers", wrap(async (req, res) => { // no phone numbers are ever returned
    const c = ownerGuard(req, res); if (!c) return;
    res.json(Object.entries(c.buyers).map(([id, b]) => ({ id, flagged: b.flagged || null, messages: b.messages.slice(-30) })));
  }));
  app.get("/api/admin/approvals", admin, (req, res) => res.json(A.all().filter((a) => a.approver === "admin").sort((x, y) => y.createdAt - x.createdAt)));
  app.get("/api/admin/deals", admin, (req, res) => res.json(Object.values(db).sort((x, y) => y.createdAt - x.createdAt).slice(0, 200)
    .map((d) => ({ id: d.id, type: d.type || "sale", title: d.title, amountInr: d.amountPaise / 100, status: d.status, disputeNote: d.disputeNote || null, createdAt: d.createdAt }))));

  // ---- Owner types a reply by hand (no approval needed: the owner IS the human) ----
  app.post("/api/cases/:id/buyers/:bid/reply", json, wrap(async (req, res) => {
    const c = ownerGuard(req, res); if (!c) return;
    const b = c.buyers[req.params.bid], to = c.phones[req.params.bid];
    if (!b || !to) return res.status(404).json({ error: "Buyer not found" });
    const text = String(req.body.text || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "Type a message" });
    if (/[\w.-]+@[a-z]{2,}/i.test(text)) return res.status(400).json({ error: "Do not share UPI IDs or emails. Payments go through the escrow link." });
    await conn.whatsappSend(to, text); // fails outside WhatsApp's 24-hour reply window
    b.messages.push({ from: "you", text }); saveCases(); res.json({ sent: true });
  }));
  // Owner agrees a price by hand: creates the escrow deal; the pay-link message still waits for the owner's approval.
  app.post("/api/cases/:id/buyers/:bid/deal", json, wrap(async (req, res) => {
    const c = ownerGuard(req, res); if (!c) return;
    if (!c.buyers[req.params.bid]) return res.status(404).json({ error: "Buyer not found" });
    const r = await A.executors.accept_offer({ buyerId: req.params.bid, amountInr: Number(req.body.amountInr) }, { caseId: c.id });
    res.json({ ...r, note: "Approve the payment-link message in your inbox to send it to the buyer." });
  }));

  // ---- Public listing page (the shareable mini-website) used by ads and links ----
  app.get("/l/:id", (req, res) => {
    const c = cases[req.params.id]; if (!c) return res.status(404).send("Listing not found");
    const e = (s) => String(s ?? "").replace(/[&<>"]/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[x]));
    const num = String(process.env.WA_BUSINESS_NUMBER || "").replace(/\D/g, "");
    const wa = num ? `https://wa.me/${num}?text=${encodeURIComponent(`Ref ${c.id} Hi, is the ${c.item.title} still available?`)}` : "";
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(c.item.title)}</title><meta property="og:title" content="${e(c.item.title)}"><link rel="stylesheet" href="/style.css"></head><body><div class="w"><div class="card"><h1>${e(c.item.title)}</h1><div class="big">&#8377;${Number(c.item.priceInr).toLocaleString("en-IN")}</div><p class="mut">${e([c.item.city, c.item.condition].filter(Boolean).join(" · "))}</p><p>${e(c.item.description)}</p>${wa ? `<a href="${e(wa)}"><button>Message on WhatsApp</button></a>` : '<p class="mut">Contact the seller through Vend.</p>'}<p class="mut">Payments are held safely in escrow until you receive the item.</p></div></div></body></html>`);
  });

  // ---- Tenant verification (provider-based; default is manual review by an admin). No ID numbers or documents are stored here. ----
  app.post("/api/cases/:id/verifications", json, wrap(async (req, res) => {
    const c = ownerGuard(req, res); if (!c) return;
    const name = String(req.body.tenantName || "").trim().slice(0, 80), phone = String(req.body.phone || "").replace(/\D/g, "");
    if (!name || phone.length < 10) return res.status(400).json({ error: "tenantName and a 10-digit phone required" });
    const id = crypto.randomBytes(5).toString("hex");
    verifs[id] = { id, caseId: c.id, tenantName: name, phoneLast4: phone.slice(-4), status: "PENDING", provider: verifyProvider.name, createdAt: Date.now() };
    vcol.save();
    res.json({ verification: verifs[id], next: await verifyProvider.start(verifs[id]) });
  }));
  app.get("/api/cases/:id/verifications", wrap(async (req, res) => { const c = ownerGuard(req, res); if (c) res.json(Object.values(verifs).filter((v) => v.caseId === c.id).sort((a, b) => b.createdAt - a.createdAt)); }));
  app.get("/api/admin/verifications", admin, (req, res) => res.json(Object.values(verifs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)));
  app.post("/api/admin/verifications/:id", admin, json, wrap(async (req, res) => {
    const v = verifs[req.params.id]; if (!v) return res.sendStatus(404);
    if (!["VERIFIED", "REJECTED"].includes(req.body.status)) return res.status(400).json({ error: "status must be VERIFIED or REJECTED" });
    v.status = req.body.status; v.note = String(req.body.note || "").slice(0, 300); v.reviewedAt = Date.now(); vcol.save(); res.json(v);
  }));

  // ---- Executors: run ONLY after a human approves ----
  A.executors.publish = async ({ channel, text }) => conn.publish(channel, text);
  A.executors.send_message = async ({ buyerId, text }, a) => {
    const c = cases[a.caseId]; const to = c.phones[buyerId]; if (!to) throw new Error("No phone for buyer");
    const r = await conn.whatsappSend(to, text.replace("{{PAY_LINK}}", a.secret?.payUrl || ""));
    (c.buyers[buyerId] ||= { messages: [] }).messages.push({ from: "you", text: text.replace("{{PAY_LINK}}", "[secure payment link]") }); saveCases();
    return r;
  };
  A.executors.accept_offer = async ({ buyerId, amountInr }, a) => {
    const c = cases[a.caseId];
    if (!c.sellerAccount) throw new Error("Seller is not onboarded yet (no linked account)");
    const d = await makeDeal({ title: c.item.title, amountInr, sellerAccount: c.sellerAccount, type: "sale" });
    // The pay link is sent to the buyer only after a SECOND approval.
    A.propose({ caseId: c.id, type: "send_message", summary: `Send escrow payment link to buyer ${buyerId}`,
      payload: { buyerId, text: `Great, we have a deal at INR ${amountInr}. Pay safely via escrow: {{PAY_LINK}}` },
      secret: { payUrl: `${process.env.PUBLIC_URL || "https://YOUR-DOMAIN"}/pay/${d.deal.id}?t=${d.buyerToken}` } }); // buyer token never shown to the seller
    return { dealId: d.deal.id, sellerToken: d.sellerToken };
  };
  A.executors.meta_ad = async (p, a) => conn.metaCreateAd({ name: `Vend ${a.caseId} ${Date.now()}`, headline: p.headline, text: p.text,
    link: `${process.env.PUBLIC_URL || "https://YOUR-DOMAIN"}/l/${a.caseId}`, dailyBudgetInr: p.dailyBudgetInr, days: p.days });
  A.executors.refund_deposit = async ({ dealId }) => {
    const d = db[dealId]; if (!d?.paymentId) throw new Error("Deal not paid");
    await rzp(`/payments/${d.paymentId}/refund`, "POST", { reverse_all: 1 }); d.status = "REFUNDED"; return { refunded: true };
  };

  // ---- WhatsApp inbound: buyer messages come in, the agent drafts a reply, the owner approves ----
  app.get("/webhooks/whatsapp", (req, res) => (req.query["hub.verify_token"] === process.env.WA_VERIFY_TOKEN ? res.send(req.query["hub.challenge"]) : res.sendStatus(403)));
  app.post("/webhooks/whatsapp", express.raw({ type: "application/json" }), async (req, res) => {
    if (!safeEq("sha256=" + hmac(process.env.WA_APP_SECRET || "x", req.body), req.get("x-hub-signature-256"))) return res.sendStatus(400);
    res.sendStatus(200);
    try {
      const m = JSON.parse(req.body.toString()).entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!m?.text?.body) return;
      const from = m.from, body = m.text.body.slice(0, 1000), ref = body.match(/Ref ([a-f0-9]{8})/)?.[1];
      const c = (ref && cases[ref]) || Object.values(cases).find((x) => Object.values(x.phones).includes(from));
      if (!c) return;
      const bid = sha(from).slice(0, 8); c.phones[bid] = from;
      const b = (c.buyers[bid] ||= { messages: [] }); b.messages.push({ from: "buyer", text: body }); saveCases();
      await runAgent({ c, trigger: `Buyer ${bid} just wrote: <buyer_message>${body}</buyer_message>. Propose a reply, a counter-offer, accept the offer, or flag a scam.`, propose: (p) => A.propose({ caseId: c.id, ...p }), save: saveCases });
    } catch (e) { console.error("whatsapp inbound:", e.message); }
  });

  // ---- Seller onboarding (Razorpay Route linked account). PAN/bank details are passed through and NEVER stored or logged here. ----
  app.post("/api/sellers", json, wrap(async (req, res) => {
    const { name, email, phone, pan, address, bank } = req.body;
    if (!name || !email || !phone || !pan || !bank?.account_number || !bank?.ifsc || !address) return res.status(400).json({ error: "name, email, phone, pan, address, bank{account_number, ifsc} required" });
    const acc = await rzp("/v2/accounts", "POST", { email, phone, type: "route", reference_id: crypto.randomBytes(6).toString("hex"),
      legal_business_name: name, business_type: "individual", contact_name: name,
      profile: { category: "ecommerce", subcategory: "ecommerce_marketplace", addresses: { registered: { street1: address.street1, street2: address.street2 || "-", city: address.city, state: address.state, postal_code: address.postal_code, country: "IN" } } },
      legal_info: { pan } });
    await rzp(`/v2/accounts/${acc.id}/stakeholders`, "POST", { name, email, kyc: { pan } });
    const prod = await rzp(`/v2/accounts/${acc.id}/products`, "POST", { product_name: "route", tnc_accepted: true });
    await rzp(`/v2/accounts/${acc.id}/products/${prod.id}`, "PATCH", { settlements: { account_number: bank.account_number, ifsc_code: bank.ifsc, beneficiary_name: bank.beneficiary_name || name }, tnc_accepted: true });
    res.json({ sellerAccount: acc.id, note: "Pass sellerAccount when creating a case. KYC may take time; check status in the Razorpay dashboard." });
  }));

  // ---- Rental deposit: full refund, or a PARTIAL SPLIT that the tenant must accept (or dispute) and an admin must approve ----
  async function splitDeposit(dealId, refundPaise) {
    const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
    const d = db[dealId]; if (!d || d.type !== "deposit") throw bad("Not a deposit deal", 404);
    if (!d.paymentId) throw bad("Deal is not paid", 409);
    if (!["PAID_HELD", "DISPUTED"].includes(d.status)) throw bad(`Deal is ${d.status}`, 409);
    if (!Number.isInteger(refundPaise) || refundPaise <= 0 || refundPaise >= d.amountPaise) throw bad("Refund must be more than 0 and less than the full deposit");
    if (!d.splitRefunded) { await rzp(`/payments/${d.paymentId}/refund`, "POST", { amount: refundPaise, reverse_all: true }); d.splitRefunded = refundPaise; save(); } // refund + reverse that part from the landlord
    else if (d.splitRefunded !== refundPaise) throw bad("A different refund was already issued for this deposit", 409);
    if (!d.transferId) { const o = await rzp(`/orders/${d.orderId}?expand[]=transfers`); d.transferId = (o.transfers?.items?.[0] ?? o.transfers?.[0])?.id; }
    await rzp(`/transfers/${d.transferId}`, "PATCH", { on_hold: 0 }); // release the remainder to the landlord
    d.status = "SPLIT"; d.refundPaise = refundPaise; save();
    return { refundedInr: refundPaise / 100, landlordInr: (d.amountPaise - refundPaise) / 100 };
  }
  A.executors.split_deposit = async ({ dealId, refundPaise }) => splitDeposit(dealId, refundPaise);
  app.post("/api/deals/:id/moveout", json, wrap(async (req, res) => {
    const d = db[req.params.id]; if (!d || d.type !== "deposit") return res.sendStatus(404);
    if (who(d, req) !== "seller") return res.sendStatus(403);
    if (d.status !== "PAID_HELD") return res.status(409).json({ error: `Status is ${d.status}` });
    const ded = Math.round(Number(req.body.deductionInr || 0) * 100);
    if (!(ded >= 0) || ded >= d.amountPaise) return res.status(400).json({ error: "Deduction must be less than the deposit. To keep all of it, the tenant must confirm." });
    if (ded === 0) { const a = A.propose({ caseId: "deposit:" + d.id, type: "refund_deposit", approver: "admin", summary: "Move-out: refund full deposit to tenant", payload: { dealId: d.id } }); return res.json({ approvalId: a.id, status: a.status }); }
    const reason = String(req.body.reason || "").trim().slice(0, 500); if (!reason) return res.status(400).json({ error: "Give a reason for the deduction" });
    d.deduction = { amountPaise: ded, reason, at: Date.now() }; save();
    res.json({ status: "WAITING_FOR_TENANT", deductionInr: ded / 100 });
  }));
  app.post("/api/deals/:id/deduction/accept", json, wrap(async (req, res) => { // tenant agrees to the landlord's proposed deduction
    const d = db[req.params.id]; if (!d || d.type !== "deposit") return res.sendStatus(404);
    if (who(d, req) !== "buyer") return res.sendStatus(403);
    if (d.status !== "PAID_HELD" || !d.deduction || d.deductionApproval) return res.status(409).json({ error: "No deduction waiting for your answer" });
    const refund = d.amountPaise - d.deduction.amountPaise;
    const a = A.propose({ caseId: "deposit:" + d.id, type: "split_deposit", approver: "admin", payload: { dealId: d.id, refundPaise: refund },
      summary: `Tenant accepted: refund INR ${refund / 100} to tenant, INR ${d.deduction.amountPaise / 100} to landlord (${d.deduction.reason})` });
    d.deductionApproval = a.id; save(); res.json({ approvalId: a.id, status: "WAITING_FOR_ADMIN" });
  }));
  app.post("/api/admin/deals/:id/split", admin, json, wrap(async (req, res) => res.json(await splitDeposit(req.params.id, Math.round(Number(req.body.refundInr) * 100))))); // admin decides a disputed deposit
}
