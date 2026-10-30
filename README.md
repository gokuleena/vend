# Vend escrow backend (India, Razorpay Route)

Money is held until the buyer confirms the item, so the seller is safe from fake payments and the buyer from fake items.

## Flow
1. Seller creates a deal (`POST /api/deals`) -> gets `sellerToken`; buyer gets `buyerToken` and the checkout details.
2. Buyer pays with Razorpay Checkout. Funds are captured; the seller's share is a **held transfer** (`on_hold`).
3. Server verifies the payment (`POST /api/deals/:id/verify`, and the webhook as backup).
4. Buyer inspects the item and taps confirm (`POST /api/deals/:id/confirm`) -> hold released -> seller is settled.
5. If the buyer does nothing, Razorpay releases it automatically after `HOLD_DAYS` (`on_hold_until`).
6. If there is a problem: `POST /api/deals/:id/dispute` freezes the money; you decide via `POST /api/admin/deals/:id/resolve` with `{"action":"release"}` or `{"action":"refund"}`.

## Run it
```bash
cp .env.example .env   # fill in Razorpay TEST keys
npm install
npm start              # needs Node 22.5 or newer (uses the built-in SQLite)
```
Set the webhook in the Razorpay dashboard to `https://YOUR-DOMAIN/webhooks/razorpay` (events `payment.captured`, `order.paid`) using the same secret as `RZP_WEBHOOK_SECRET`.

## Frontend: pay button (add to the Vend page)
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
async function pay() {
  const r = await fetch("/api/deals", { method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ title: "MacBook Air 2020", amountInr: 42000, sellerAccount: "acc_XXXXXXXX" }) });
  const { deal, buyerToken, checkout } = await r.json();
  new Razorpay({ key: checkout.keyId, order_id: checkout.orderId, amount: checkout.amount, currency: "INR",
    name: "Vend", description: deal.title,
    handler: (resp) => fetch(`/api/deals/${deal.id}/verify`, { method: "POST",
      headers: {"Content-Type":"application/json", Authorization: "Bearer " + buyerToken}, body: JSON.stringify(resp) })
  }).open();
}
</script>
```
After the meetup, the buyer calls `POST /api/deals/:id/confirm` with the same `Authorization: Bearer <buyerToken>` header.

## Before real money (important)
- **Razorpay Route** must be activated on your account (apply via Razorpay; test mode first). Route transfers are INR only.
- Each seller needs a **linked account** (`acc_...`) with their KYC and bank details, created through Razorpay Route onboarding. Do not collect Aadhaar or bank details yourself.
- Holding customer money is regulated in India. Get a CA/lawyer to check your setup, terms of service, refund and dispute policy, and GST on your fee.
- Run behind HTTPS, add logging/alerts, back up `vend.db` regularly, and restrict `/api/admin` and `/admin.html` to your team.
- Test every path in test mode: pay, confirm, auto-release, dispute then release, dispute then refund.

## AI agent with human approval (new)
The Claude agent (`agent.js`) drafts, prices and negotiates, but it can only **propose**. Nothing with a side effect runs until a human approves in `approvals.js`.

| Agent can do alone | Needs human approval | Agent can never do |
|---|---|---|
| Improve listing, suggest price, flag scammers, read buyer messages | Publish an ad, send any message to a buyer, accept an offer and open escrow, send the pay link (a second approval) | Move, release or refund money, reveal your floor price |

Guardrails live in code, not just the prompt: offers below your floor are blocked; messages with phone numbers, UPI IDs or your floor price are blocked; buyer messages are wrapped as untrusted data; proposals expire in 48h; approving twice runs the action once.

Endpoints (owner token = `Authorization: Bearer <ownerToken>`):
- `POST /api/cases` create a listing case (returns `ownerToken` and a `Ref <id>` to put in the ad's WhatsApp text)
- `POST /api/cases/:id/agent` ask the agent to work, for example `{"instruction":"write the ad and propose channels"}`
- `GET /api/cases/:id/approvals` list proposals; `POST /api/approvals/:id/decide` with `{"approve":true|false}`
- `POST /webhooks/whatsapp` inbound buyer messages from the WhatsApp Cloud API; the agent drafts a reply and you approve it

## Seller onboarding
`POST /api/sellers` creates the Razorpay Route linked account (account, stakeholder, product, settlement bank). PAN and bank details are passed through to Razorpay and not stored or logged. Check the field values (category, subcategory, stakeholder fields) against the current Razorpay Route docs in test mode before use; they were written from the docs and not run against a live account.

## Rental deposits
`POST /api/deals` with `{"type":"deposit", ...}` holds the deposit with no fee and no auto-release. At move-out the landlord calls `POST /api/deals/:id/moveout`; this creates an admin approval to refund the tenant. Deduction claims go to manual review (partial splits are not automated yet).

## Channels
WhatsApp is automated (after approval). OLX, Quikr, Facebook Marketplace, Instagram and WhatsApp Status are assisted: the ad text is prepared and a human posts it, because they have no public posting API. Meta Ads is a TODO in `connectors.js`.

## Pages (new)
- **Owner inbox:** `/owner.html`. Create a listing, ask the agent to work, and approve or reject each proposal. Approved ad posts show a Copy button and an Open-site button so you can post it yourself. Keep the owner token private; it is shown once.
- **Buyer pay page:** `/pay/:id?t=<buyerToken>`. The buyer pays through Razorpay Checkout, then taps "I received it" to release the money, or "Report a problem" to freeze it. The token is removed from the address bar after the first load.
- The accept-offer approval creates the deal and then proposes a second message containing this pay link, so you approve before the buyer sees it.
- Set `PUBLIC_URL` in `.env` to your real domain so the pay link is correct. Serve over HTTPS in production.

## Admin screen and buyer conversations (new)
- **Admin:** `/admin.html`, sign in with `ADMIN_TOKEN`. It shows disputed payments (Release to seller / Refund buyer, each with a confirmation), deposit and manual-review approvals, and a table of all deals. Keep this page behind a VPN or IP allow-list in production.
- **Buyer conversations:** shown in the owner inbox under each listing. Buyers appear as short IDs; phone numbers are never sent to the browser. Scam flags are shown as warnings.
- **Security fix:** the buyer's private pay token is now kept out of everything the seller can see. The seller sees "[secure payment link added automatically]" and the link is inserted only when the message is sent. Otherwise a seller could have used the token to release the buyer's money to themselves.

## Database and tests (new)
- **Storage:** data now lives in one SQLite file (`vend.db`, set a different path with `DB_FILE`), using Node's built-in SQLite. Writes are transactional and only changed records are saved. If you ran the earlier version, your `deals.json`, `cases.json` and `approvals.json` are imported automatically on first start and renamed to `*.imported`.
- **Scale note:** SQLite on one server is fine for a pilot and early users. For several servers or heavy traffic, move to Postgres; only `store.js` needs to change.
- **Tests:** `npm test` runs 25 automated tests. They start the real server against fake Razorpay, Claude and WhatsApp services, so no keys or real money are involved. They cover: payment signatures, held money and fees, release once, disputes, refunds, deposits, webhooks, restart persistence, the agent proposing but never acting, the code guardrails, offers below the floor, and the buyer's pay token never being visible to the seller.
- **Limits of the guardrails:** the code blocks the exact floor price, phone numbers and UPI IDs in agent messages. The agent is also told never to hint at your limit, but a paraphrase like "I can go a bit lower" is controlled by instructions, not code. Keep approving every message.

## Latest additions
- **Owner replies by hand:** type a reply to any buyer in the owner inbox (sent on WhatsApp), or "Ask the agent to draft". "Create escrow payment link" opens an escrow deal at the price you agreed; the pay-link message still needs your approval. WhatsApp only allows free-text replies within 24 hours of the buyer's last message.
- **Public listing page:** `/l/<caseId>` is a shareable page with a WhatsApp button (set `WA_BUSINESS_NUMBER`). It never shows your lowest price.
- **Meta Ads:** the agent can propose an ad (`propose_ad`). After your approval it creates the campaign, ad set, creative and ad **paused**, so no money is spent until you switch it on in Ads Manager. Daily budget is capped by `META_MAX_DAILY_INR` (default 500) and 14 days. Targeting is all of India, 18+. This was tested only against a fake Meta service; you need a Meta app with ads permission, an ad account and a Page, and Meta's ad policies apply to your item type.
- **Tenant verification:** the owner requests a check, a Vend admin records VERIFIED or REJECTED (`/admin.html`). Only the name, last 4 phone digits, status and a note are stored; never ID numbers or documents. `verification.js` is where a licensed KYC provider plugs in; none is connected, because that needs a contract and their API.
- **Partial deposit splits:** landlord proposes a deduction with a reason, the tenant accepts (or disagrees, which opens a dispute), an admin approves, then the server refunds the tenant's part (partial refund with `reverse_all`) and releases the rest to the landlord. Admins can also split a disputed deposit directly. If the second step fails, a retry never refunds twice.
- **Deploy:** see `DEPLOY.md` (Render blueprint in `render.yaml`, plus a `Dockerfile`).

## Not built yet
A connected KYC provider (needs a contract), Meta click-to-WhatsApp ads and city-level targeting, photo uploads on listings, an owner-facing deal status screen, and a Postgres option for larger scale.
