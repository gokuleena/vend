# Get a permanent link (about 15 minutes, no server skills needed)

The easiest route is **Render**. You get a permanent `https://vend-xxxx.onrender.com` address, free HTTPS, and a disk that keeps your data.

## Steps
1. **Put the code on GitHub.** Create a free account, click New repository, then "uploading an existing file" and drag in everything from this folder **except** `node_modules`. (Do not upload `.env`.)
2. **Create the service on Render.** Sign up at render.com, click **New > Blueprint**, connect GitHub and pick the repository. Render reads `render.yaml` and sets everything up. A persistent disk needs a paid plan (the "starter" plan in `render.yaml`); check Render's current pricing. Without a disk, your data is lost on every restart.
3. **Fill in the secrets** when Render asks (Environment tab). `ADMIN_TOKEN` and `WA_VERIFY_TOKEN` are generated for you; read them in the Environment tab. Start with only these: `ANTHROPIC_API_KEY`, `RZP_KEY_ID`, `RZP_KEY_SECRET` (use **test** keys), `RZP_WEBHOOK_SECRET`.
4. **Set `PUBLIC_URL`** to the address Render gives you (for example `https://vend-xxxx.onrender.com`), then redeploy.
5. **Connect webhooks:**
   - Razorpay dashboard > Webhooks: `https://YOUR-ADDRESS/webhooks/razorpay`, events `payment.captured` and `order.paid`, same secret as `RZP_WEBHOOK_SECRET`.
   - Meta (WhatsApp) app: callback `https://YOUR-ADDRESS/webhooks/whatsapp`, verify token = `WA_VERIFY_TOKEN`.
6. **Open your link.** `https://YOUR-ADDRESS/` is the front door. Sellers use `/owner.html`, you use `/admin.html` (sign in with `ADMIN_TOKEN`). Each listing also gets a public page at `/l/<caseId>`.

## Good to know
- Use Razorpay **test** keys until you have tested every path and Razorpay has approved Route for you.
- A custom domain (like `vend.in`) can be added in Render's Settings later; the link above keeps working.
- Back up the disk (Render offers snapshots) before real users.
- Other hosts that work with the included `Dockerfile`: Railway and Fly.io. Both also need a persistent volume mounted at `/data`.
- I could not run the Docker build or a live deploy from here. The code and all 25 tests were run locally; the first deploy may need small fixes.
