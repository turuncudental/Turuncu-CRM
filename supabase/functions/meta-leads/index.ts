// Turuncu CRM – Meta Lead Ads webhook (Supabase Edge Function: meta-leads)
// v2: Lead'i form/kampanya adına göre doğru FİRMA + EVENT'e kaydeder.
//
// Eşleştirme kuralı:
//   Meta'daki FORM adı (yoksa kampanya / reklam seti adı) CRM'deki event adını
//   içeriyorsa lead o event'e ve event'in bağlı olduğu firmaya yazılır.
//   Örn. CRM event: "Whitstable 15th Nov"  ->  Meta form: "Whitstable 15th Nov Form"
//   Birden fazla event eşleşirse: en uzun isim kazanır; yine eşitse tarihi en yakın olan.
//   Hiç eşleşme yoksa lead varsayılan firmaya (COMPANY_ID) event'siz düşer.
//
// Secrets: META_VERIFY_TOKEN, META_ACCESS_TOKEN (Sayfa token), COMPANY_ID (varsayılan firma),
//          META_APP_SECRET (Meta App Secret – sahte istekleri engeller)

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOK = Deno.env.get("META_VERIFY_TOKEN") ?? "";
const DEFAULT_COMPANY = Number(Deno.env.get("COMPANY_ID") ?? "1");
const ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN") ?? "";
const GRAPH = "https://graph.facebook.com/v26.0";
const LEAD_STATUS = "lead"; // CRM'deki "Meta Lead" statüsünün anahtarı farklıysa burayı değiştirin

const headers = {
  "Content-Type": "application/json",
  "apikey": SUPA_KEY,
  "Authorization": `Bearer ${SUPA_KEY}`,
};

// ---------- Meta imza doğrulaması (META_APP_SECRET girilmişse zorunlu) ----------
async function validSignature(raw: string, header: string | null) {
  const secret = Deno.env.get("META_APP_SECRET");
  if (!secret) return true;
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------- Meta Graph API ----------
async function graph(path: string, fields: string) {
  const r = await fetch(`${GRAPH}/${path}?fields=${fields}&access_token=${ACCESS_TOKEN}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    console.warn(`Graph ${path} (${fields}) hata:`, JSON.stringify(j.error ?? r.status));
    return null;
  }
  return j;
}

async function fetchLead(leadgenId: string) {
  // Reklam bilgileri reklam hesabı izni ister; olmazsa sadece form verisini al
  return (await graph(
    leadgenId,
    "field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,created_time",
  )) ?? (await graph(leadgenId, "field_data,form_id,created_time"));
}

function getField(fd: { name: string; values: string[] }[], ...keys: string[]) {
  for (const k of keys) {
    const v = fd.find((f) => f.name === k)?.values?.[0];
    if (v) return v;
  }
  return "";
}

// ---------- Supabase (tablo başına firma satırı: { id, data: [...] }) ----------
async function readRow(table: string, companyId: number): Promise<any[] | null> {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${companyId}&select=data`, { headers });
  if (!r.ok) return null; // OKUMA HATASI -> null (asla boş listeyle üzerine yazma!)
  const rows = await r.json();
  return Array.isArray(rows?.[0]?.data) ? rows[0].data : [];
}

async function writeCustomers(companyId: number, data: any[]) {
  const r = await fetch(`${SUPA_URL}/rest/v1/customers?id=eq.${companyId}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ data }),
  });
  const patched = r.ok ? await r.json() : [];
  if (!patched?.length) {
    const ins = await fetch(`${SUPA_URL}/rest/v1/customers`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ id: companyId, data }),
    });
    if (!ins.ok) throw new Error(`customers yazılamadı (firma ${companyId}): ${await ins.text()}`);
  }
}

async function loadAllEvents() {
  const r = await fetch(`${SUPA_URL}/rest/v1/deals?select=id,data`, { headers });
  if (!r.ok) return [];
  const rows: { id: number; data: any[] }[] = await r.json();
  const out: { companyId: number; ev: any }[] = [];
  for (const row of rows) {
    for (const ev of Array.isArray(row.data) ? row.data : []) {
      if (ev?.deleted || ev?.active === false || !ev?.name) continue;
      out.push({ companyId: Number(row.id), ev });
    }
  }
  return out;
}

const norm = (s: string) =>
  (s ?? "").toLocaleLowerCase("en").normalize("NFKD").replace(/[^a-z0-9]/g, "");

function matchEvent(events: { companyId: number; ev: any }[], texts: string[]) {
  const today = Date.now();
  for (const text of texts) {
    const t = norm(text);
    if (!t) continue;
    const hits = events.filter((e) => norm(e.ev.name).length >= 3 && t.includes(norm(e.ev.name)));
    if (!hits.length) continue;
    hits.sort((a, b) => {
      const len = norm(b.ev.name).length - norm(a.ev.name).length;
      if (len) return len;
      // Aynı isim: önce yaklaşan (bugün/ileri tarihli) en yakın event, yoksa en son geçmiş event
      const score = (e: any) => {
        const end = Date.parse(e.ev.dateEnd || e.ev.dateStart || e.ev.date || "");
        if (isNaN(end)) return 4e15;
        const d = end + 86400000 - today; // event günü sonuna kadar "yaklaşan" sayılır
        return d >= 0 ? d : 2e15 - d;
      };
      return score(a) - score(b);
    });
    return hits[0];
  }
  return null;
}

// ---------- Webhook ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === VERIFY_TOK &&
      url.searchParams.get("hub.challenge");
    return ok
      ? new Response(url.searchParams.get("hub.challenge")!, { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    console.warn("Geçersiz imza – istek reddedildi (Meta'dan gelmiyor)");
    return new Response("Invalid signature", { status: 401 });
  }
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("Bad Request", { status: 400 }); }

  try {
    const events = await loadAllEvents();
    const formNames = new Map<string, string>();
    const byCompany = new Map<number, any[]>();

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
        const val = change.value;
        const lead = (await fetchLead(val.leadgen_id)) ?? {};
        const fd = lead.field_data ?? val.field_data ?? [];

        const formId = String(lead.form_id ?? val.form_id ?? "");
        if (formId && !formNames.has(formId)) {
          formNames.set(formId, (await graph(formId, "name"))?.name ?? "");
        }
        const formName = formNames.get(formId) ?? "";

        const match = matchEvent(events, [formName, lead.campaign_name ?? "", lead.adset_name ?? ""]);
        const companyId = match?.companyId ?? DEFAULT_COMPANY;

        const fullName = getField(fd, "full_name") ||
          `${getField(fd, "first_name")} ${getField(fd, "last_name")}`.trim();

        const customer = {
          name: fullName || "Meta Lead",
          email: getField(fd, "email"),
          phone: getField(fd, "phone_number", "phone"),
          country: getField(fd, "country"),
          city: getField(fd, "city"),
          status: LEAD_STATUS,
          source: "Meta Ads",
          eventId: match?.ev.id ?? null,
          metaLeadId: String(val.leadgen_id),
          formId,
          formName,
          campaignId: lead.campaign_id ?? "",
          campaignName: lead.campaign_name ?? "",
          adsetName: lead.adset_name ?? "",
          adId: lead.ad_id ?? val.ad_id ?? "",
          adName: lead.ad_name ?? "",
          platform: lead.platform ?? "",
          createdAt: new Date().toISOString().split("T")[0],
          notes: match ? [] : [{ text: `Event eşleşmedi. Form: "${formName}" Kampanya: "${lead.campaign_name ?? ""}"`, date: new Date().toISOString() }],
          files: [],
          booking: {},
          treatments: [],
        };
        console.log(`Lead ${val.leadgen_id} -> firma ${companyId}, event ${customer.eventId ?? "YOK"} (form "${formName}")`);

        if (!byCompany.has(companyId)) byCompany.set(companyId, []);
        byCompany.get(companyId)!.push(customer);
      }
    }

    for (const [companyId, leads] of byCompany) {
      const existing = await readRow("customers", companyId);
      if (existing === null) throw new Error(`customers okunamadı (firma ${companyId}) – yazma iptal`);

      const seen = new Set(existing.map((c: any) => c.metaLeadId).filter(Boolean));
      const fresh = leads.filter((l) => !seen.has(l.metaLeadId));
      if (!fresh.length) continue;

      const base = Date.now();
      const withIds = fresh.map((l, i) => ({ id: base + i, ...l }));
      await writeCustomers(companyId, [...existing, ...withIds]);
      console.log(`Firma ${companyId}: ${withIds.length} lead eklendi`);
    }
  } catch (e) {
    console.error("Meta lead işleme hatası:", e);
  }

  return new Response("OK", { status: 200 });
});
