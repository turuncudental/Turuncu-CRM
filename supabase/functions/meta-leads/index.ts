// Turuncu CRM – Meta Lead Ads webhook (Supabase Edge Function: meta-leads)
// v3: Tüm Meta lead'leri LUXARK firmasına yazılır; event yoksa otomatik oluşturulur.
//
// Kurallar:
//   ŞEHİR  -> kampanya adından ("Ramsgate Event | Lead Gen (JB) | New" -> Ramsgate)
//   TARİH  -> form adından, şehir sırasıyla eşleşir
//             ("Ramsgate - Dartford | Dec 12-13 | Lead Form" -> Ramsgate=12 Ara, Dartford=13 Ara)
//   EVENT  -> Luxark'ta aynı şehir + aynı tarihli event varsa ona yazılır;
//             yoksa otomatik oluşturulur (autoCreated: true, source: "Meta").
//   Şehir veya tarih çözülemezse: eski isim eşleştirmesi denenir; o da olmazsa event'siz düşer.
//
// Secrets: META_VERIFY_TOKEN, META_ACCESS_TOKEN (sistem kullanıcısı token'ı),
//          META_APP_SECRET, META_COMPANY_ID (varsayılan 2 = Luxark)

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOK = Deno.env.get("META_VERIFY_TOKEN") ?? "";
const META_COMPANY = Number(Deno.env.get("META_COMPANY_ID") ?? "2"); // Luxark
const ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN") ?? "";
const GRAPH = "https://graph.facebook.com/v26.0";
const LEAD_STATUS = "lead"; // CRM'deki "Meta Lead" statüsünün anahtarı

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
  // Reklam bilgileri ads_read ister; olmazsa sadece form verisi al
  return (await graph(
    leadgenId,
    "field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,created_time",
  )) ?? (await graph(leadgenId, "field_data,form_id,created_time"));
}

type FD = { name: string; values: string[] }[];

function getField(fd: FD, ...keys: string[]) {
  for (const k of keys) {
    const v = fd.find((f) => f.name === k)?.values?.[0];
    if (v) return v;
  }
  return "";
}

// Standart alanlar dışındaki form cevapları (ör. "which_treatment_are_you_most_interested_in?")
const STD_FIELDS = new Set([
  "full_name", "first_name", "last_name", "email", "email_address", "phone_number", "phone",
  "country", "city", "inbox_url",
]);
function extraAnswers(fd: FD) {
  return fd
    .filter((f) => !STD_FIELDS.has(f.name) && f.values?.[0])
    .map((f) => ({
      question: f.name.replace(/[_?]+/g, " ").trim(),
      answer: f.values.join(", "),
    }));
}

// ---------- Supabase (tablo başına firma satırı: { id, data: [...] }) ----------
async function readRow(table: string, companyId: number): Promise<any[] | null> {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${companyId}&select=data`, { headers });
  if (!r.ok) return null; // OKUMA HATASI -> null (asla boş listeyle üzerine yazma!)
  const rows = await r.json();
  return Array.isArray(rows?.[0]?.data) ? rows[0].data : [];
}

async function writeRow(table: string, companyId: number, data: any[]) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${companyId}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ data }),
  });
  const patched = r.ok ? await r.json() : [];
  if (!patched?.length) {
    const ins = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ id: companyId, data }),
    });
    if (!ins.ok) throw new Error(`${table} yazılamadı (firma ${companyId}): ${await ins.text()}`);
  }
}

const norm = (s: string) =>
  (s ?? "").toLocaleLowerCase("en").normalize("NFKD").replace(/[^a-z0-9]/g, "");

const activeEvents = (events: any[]) =>
  events.filter((ev) => ev && !ev.deleted && ev.active !== false && ev.name);

// ---------- Şehir / tarih çözümleme ----------
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  oca: 1, şub: 2, nis: 4, mayıs: 5, haz: 6, tem: 7, ağu: 8, eyl: 9, eki: 10, kas: 11, ara: 12,
};

// "Ramsgate Event | Lead Gen (JB) | New" -> "Ramsgate"
function cityFromCampaign(name: string): string {
  const first = (name ?? "").split("|")[0];
  return first.replace(/\b(event|events|etkinlik)\b/gi, "").replace(/\s+/g, " ").trim();
}

// "Dec 12-13" / "12-13 Dec" / "Dec 12 & 13" / "12 December" -> { month, days: [12, 13] }
function parseDates(text: string): { month: number; days: number[] } | null {
  const t = (text ?? "").toLocaleLowerCase("en");
  const D = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
  const DAYS = String.raw`${D}(?:\s*(?:[-–&,\/]|and)\s*${D})*`;
  const MON = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|` +
    String.raw`sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ocak|şubat|mart|nisan|mayıs|haziran|` +
    String.raw`temmuz|ağustos|eylül|ekim|kasım|aralık)`;
  const END = String.raw`(?![a-zçğıöşü])`;
  const re1 = new RegExp(String.raw`(?<![a-zçğıöşü])(${MON})${END}\.?\s+(${DAYS})\b`, "g"); // Dec 12-13
  const re2 = new RegExp(String.raw`\b(${DAYS})\s+(?:of\s+)?(${MON})${END}`, "g"); // 12-13 Dec
  for (const [re, mi, di] of [[re1, 1, 2], [re2, 2, 1]] as const) {
    for (const m of t.matchAll(re)) {
      const month = MONTHS[m[mi].slice(0, 3)];
      if (!month) continue;
      const days = m[di].split(/\s*(?:[-–&,\/]|and)\s*/).map((d) => parseInt(d, 10))
        .filter((d) => d >= 1 && d <= 31);
      if (days.length) return { month, days };
    }
  }
  return null;
}

// Etkinlik yılı: bugünden 60 günden fazla geride kalıyorsa bir sonraki yıl
function isoDate(month: number, day: number): string {
  const now = new Date();
  let y = now.getUTCFullYear();
  const cand = Date.UTC(y, month - 1, day);
  if (cand < now.getTime() - 60 * 86400000) y++;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Form adından bu şehrin tarihini bul.
// "Ramsgate - Dartford | Dec 12-13" -> şehir listesi [Ramsgate, Dartford], gün listesi [12, 13]
function dateForCity(formName: string, city: string): { start: string; end: string } | null {
  const parts = (formName ?? "").split("|").map((p) => p.trim());
  const dates = parseDates(formName);
  if (!dates) return null;
  const one = (d: number) => ({ start: isoDate(dates.month, d), end: isoDate(dates.month, d) });
  if (dates.days.length === 1) return one(dates.days[0]);
  const SEP = /\s*[-–&,\/]\s*|\s+and\s+/i;
  const cityPart = parts.find((p) => p.split(SEP).length === dates.days.length && !parseDates(p)) ?? "";
  const cities = cityPart.split(SEP).map(norm);
  const idx = cities.findIndex((c) => c && (c === norm(city) || c.includes(norm(city)) || norm(city).includes(c)));
  if (idx >= 0) return one(dates.days[idx]);
  // Tek şehir, çok günlü etkinlik ("Margate 3rd & 4th December") -> ilk gün - son gün
  if (norm(formName).includes(norm(city))) {
    return {
      start: isoDate(dates.month, dates.days[0]),
      end: isoDate(dates.month, dates.days[dates.days.length - 1]),
    };
  }
  return null;
}

// Eski kural: metin event adını içeriyorsa (en uzun isim, sonra en yakın tarih kazanır)
function matchByName(events: any[], texts: string[]) {
  const today = Date.now();
  for (const text of texts) {
    const t = norm(text);
    if (!t) continue;
    const hits = events.filter((ev) => norm(ev.name).length >= 3 && t.includes(norm(ev.name)));
    if (!hits.length) continue;
    hits.sort((a, b) => {
      const len = norm(b.name).length - norm(a.name).length;
      if (len) return len;
      const score = (ev: any) => {
        const end = Date.parse(ev.dateEnd || ev.dateStart || ev.date || "");
        if (isNaN(end)) return 4e15;
        const d = end + 86400000 - today;
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
    const events = await readRow("deals", META_COMPANY);
    if (events === null) throw new Error(`deals okunamadı (firma ${META_COMPANY}) – yazma iptal`);
    let eventsChanged = false;
    const formNames = new Map<string, string>();
    const leads: any[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
        const val = change.value;
        const lead = (await fetchLead(val.leadgen_id)) ?? {};
        const fd: FD = lead.field_data ?? val.field_data ?? [];

        const formId = String(lead.form_id ?? val.form_id ?? "");
        if (formId && !formNames.has(formId)) {
          formNames.set(formId, (await graph(formId, "name"))?.name ?? "");
        }
        const formName = formNames.get(formId) ?? "";
        const campaignName = lead.campaign_name ?? "";

        // 1) Şehir (kampanyadan) + tarih (formdan) -> event bul / oluştur
        let ev: any = null;
        const city = cityFromCampaign(campaignName);
        const range = city ? dateForCity(formName, city) : null;
        const date = range?.start ?? null;
        if (city && range && date) {
          ev = activeEvents(events).find((e) =>
            (norm(e.name) === norm(city) || norm(e.city) === norm(city)) &&
            (e.dateStart || e.date) === date
          );
          if (!ev) {
            ev = {
              id: Date.now() + events.length,
              name: city,
              city,
              venue: "",
              date,
              dateStart: date,
              dateEnd: range.end,
              active: true,
              autoCreated: true,
              source: "Meta",
              createdAt: new Date().toISOString(),
            };
            events.push(ev);
            eventsChanged = true;
            console.log(`Event otomatik oluşturuldu: ${city} ${date} (firma ${META_COMPANY})`);
          }
        }
        // 2) Çözülemezse eski isim eşleştirmesi (sadece Luxark event'leri)
        if (!ev) {
          ev = matchByName(activeEvents(events), [campaignName, formName, lead.adset_name ?? ""]);
        }

        const fullName = getField(fd, "full_name") ||
          `${getField(fd, "first_name")} ${getField(fd, "last_name")}`.trim();
        const answers = extraAnswers(fd);
        const treatment = answers.find((a) => /treatment|tedavi/i.test(a.question))?.answer ?? "";

        const notes: any[] = [];
        if (treatment) {
          notes.push({ text: `İlgilendiği tedavi: ${treatment}`, date: new Date().toISOString() });
        }
        if (!ev) {
          notes.push({
            text: `Event eşleşmedi. Form: "${formName}" Kampanya: "${campaignName}"`,
            date: new Date().toISOString(),
          });
        }

        leads.push({
          name: fullName || "Meta Lead",
          email: getField(fd, "email", "email_address"),
          phone: getField(fd, "phone_number", "phone"),
          country: getField(fd, "country"),
          city: getField(fd, "city"),
          status: LEAD_STATUS,
          source: "Meta Ads",
          eventId: ev?.id ?? null,
          metaLeadId: String(val.leadgen_id),
          formId,
          formName,
          campaignId: lead.campaign_id ?? "",
          campaignName,
          adsetName: lead.adset_name ?? "",
          adId: lead.ad_id ?? val.ad_id ?? "",
          adName: lead.ad_name ?? "",
          platform: lead.platform ?? "",
          treatmentInterest: treatment,
          formAnswers: answers,
          createdAt: new Date().toISOString().split("T")[0],
          notes,
          files: [],
          booking: {},
          treatments: [],
        });
        console.log(
          `Lead ${val.leadgen_id} -> firma ${META_COMPANY}, event ${ev ? `${ev.name} ${ev.dateStart || ev.date}` : "YOK"}` +
            ` (form "${formName}", kampanya "${campaignName}")`,
        );
      }
    }

    if (eventsChanged) await writeRow("deals", META_COMPANY, events);

    if (leads.length) {
      const existing = await readRow("customers", META_COMPANY);
      if (existing === null) throw new Error(`customers okunamadı (firma ${META_COMPANY}) – yazma iptal`);
      const seen = new Set(existing.map((c: any) => c.metaLeadId).filter(Boolean));
      const fresh = leads.filter((l) => !seen.has(l.metaLeadId));
      if (fresh.length) {
        const base = Date.now();
        const withIds = fresh.map((l, i) => ({ id: base + i, ...l }));
        await writeRow("customers", META_COMPANY, [...existing, ...withIds]);
        console.log(`Firma ${META_COMPANY}: ${withIds.length} lead eklendi`);
      }
    }
  } catch (e) {
    console.error("Meta lead işleme hatası:", e);
  }

  return new Response("OK", { status: 200 });
});
