const SUPA_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPA_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOK = Deno.env.get("META_VERIFY_TOKEN") ?? "turuncu_meta_2024";
const COMPANY_ID = Number(Deno.env.get("COMPANY_ID") ?? "1");

const headers = {
  "Content-Type": "application/json",
  "apikey": SUPA_KEY,
  "Authorization": `Bearer ${SUPA_KEY}`,
};

/** Fetch the lead's field values from Meta Graph API */
async function fetchLeadFields(leadgenId: string, accessToken: string) {
  const url = `https://graph.facebook.com/v19.0/${leadgenId}?fields=field_data&access_token=${accessToken}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return await r.json();
}

function getField(fieldData: { name: string; values: string[] }[], key: string) {
  return fieldData.find((f) => f.name === key)?.values?.[0] ?? "";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ── Meta webhook verification (GET) ──────────────────────────────────────
  if (req.method === "GET") {
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOK && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── Lead webhook payload (POST) ───────────────────────────────────────────
  if (req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

    const accessToken = Deno.env.get("META_ACCESS_TOKEN") ?? "";
    const newLeads: any[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen") continue;

        const val = change.value;
        let fieldData = val.field_data ?? [];

        // If field_data is not inline, fetch from Graph API
        if (fieldData.length === 0 && val.leadgen_id && accessToken) {
          const detail = await fetchLeadFields(val.leadgen_id, accessToken);
          fieldData = detail?.field_data ?? [];
        }

        const firstName = getField(fieldData, "first_name");
        const lastName  = getField(fieldData, "last_name");
        const fullName  = getField(fieldData, "full_name") || `${firstName} ${lastName}`.trim();
        const email     = getField(fieldData, "email");
        const phone     = getField(fieldData, "phone_number") || getField(fieldData, "phone");

        if (!fullName && !email && !phone) continue;

        newLeads.push({
          name:       fullName || "Meta Lead",
          email,
          phone,
          status:     "lead",
          source:     "Meta Ads",
          adId:       val.ad_id        ?? "",
          campaignId: val.campaign_id  ?? "",
          adName:     val.ad_name      ?? "",
          formId:     val.form_id      ?? "",
          createdAt:  new Date().toISOString().split("T")[0],
          notes:      [],
          files:      [],
          booking:    {},
          treatments: [],
        });
      }
    }

    if (newLeads.length === 0) {
      return new Response("OK – no leads", { status: 200 });
    }

    // ── Read current customers row ────────────────────────────────────────
    const getRes = await fetch(
      `${SUPA_URL}/rest/v1/customers?id=eq.${COMPANY_ID}&select=data`,
      { headers }
    );
    const rows: { data: any[] }[] = getRes.ok ? await getRes.json() : [];
    const existing: any[] = rows?.[0]?.data ?? [];

    // Generate new IDs (max existing + 1, 2, …)
    const maxId = existing.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0);
    const withIds = newLeads.map((l, i) => ({ id: maxId + i + 1, ...l }));
    const merged = [...existing, ...withIds];

    // ── Upsert back ───────────────────────────────────────────────────────
    const patchRes = await fetch(
      `${SUPA_URL}/rest/v1/customers?id=eq.${COMPANY_ID}`,
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ data: merged }),
      }
    );
    const patched = patchRes.ok ? await patchRes.json() : [];

    if (!patched?.length) {
      // Row doesn't exist yet — insert
      await fetch(`${SUPA_URL}/rest/v1/customers`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ id: COMPANY_ID, data: merged }),
      });
    }

    console.log(`Meta Leads: ${withIds.length} lead(s) added for company ${COMPANY_ID}`);
    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
