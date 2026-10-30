// Channel connectors. Only WhatsApp Cloud API is a real automated connector here.
// Marketplaces without a public posting API (OLX, Quikr, Facebook Marketplace) are ASSISTED: we prepare the ad, a human posts it.
const { WA_TOKEN, WA_PHONE_ID, WA_API_VERSION = "v21.0" } = process.env;

export async function whatsappSend(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error("WhatsApp is not configured (WA_TOKEN / WA_PHONE_ID)");
  // Note: free-text messages only work inside the 24h customer-service window (after the buyer messages you first).
  const r = await fetch(`${process.env.WA_BASE || "https://graph.facebook.com"}/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || "WhatsApp send failed");
  return { sent: true, id: j.messages?.[0]?.id };
}

const ASSISTED = { olx: "https://www.olx.in", quikr: "https://www.quikr.com", facebook_marketplace: "https://www.facebook.com/marketplace/create", instagram: "https://www.instagram.com", whatsapp_status: "https://web.whatsapp.com" };

export async function publish(channel, text) {
  if (ASSISTED[channel]) return { mode: "assisted", channel, openUrl: ASSISTED[channel], copyText: text, note: "Open the site, paste the text, add photos and post." };
  // TODO: Meta Ads (Marketing API) and similar need app review + ad-account setup; add a connector here when ready.
  throw new Error(`No connector for ${channel}`);
}

// ---- Meta (Facebook/Instagram) ads. Everything is created PAUSED: no money is spent until a human switches the ad on in Ads Manager. ----
const { META_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID, META_API_VERSION = "v21.0", META_MAX_DAILY_INR = "500" } = process.env;
async function meta(path, body) {
  const r = await fetch(`${process.env.META_BASE || "https://graph.facebook.com"}/${META_API_VERSION}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || "Meta API error");
  return j;
}
export const metaLimits = () => ({ min: 50, max: Number(META_MAX_DAILY_INR), maxDays: 14 });
export async function metaCreateAd({ name, headline, text, link, dailyBudgetInr, days }) {
  if (!META_TOKEN || !META_AD_ACCOUNT_ID || !META_PAGE_ID) throw new Error("Meta Ads is not configured (META_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID)");
  const L = metaLimits();
  if (!(dailyBudgetInr >= L.min && dailyBudgetInr <= L.max)) throw new Error(`Daily budget must be between INR ${L.min} and ${L.max}`);
  if (!(days >= 1 && days <= L.maxDays)) throw new Error(`Days must be between 1 and ${L.maxDays}`);
  const act = `/act_${META_AD_ACCOUNT_ID}`;
  const camp = await meta(`${act}/campaigns`, { name, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [] });
  const set = await meta(`${act}/adsets`, { name, campaign_id: camp.id, daily_budget: Math.round(dailyBudgetInr * 100), billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", end_time: Math.floor(Date.now() / 1000) + days * 86400,
    targeting: { geo_locations: { countries: ["IN"] }, age_min: 18 }, status: "PAUSED" });
  const cr = await meta(`${act}/adcreatives`, { name, object_story_spec: { page_id: META_PAGE_ID, link_data: { link, message: text, name: headline, call_to_action: { type: "LEARN_MORE", value: { link } } } } });
  const ad = await meta(`${act}/ads`, { name, adset_id: set.id, creative: { creative_id: cr.id }, status: "PAUSED" });
  return { paused: true, campaignId: camp.id, adSetId: set.id, adId: ad.id, maxSpendInr: dailyBudgetInr * days,
    note: "Created PAUSED. Review it in Meta Ads Manager and switch it on there. Check Meta's ad policies for your item type first." };
}
