// Ortak yardımcılar: crm-login ve crm-users fonksiyonları kullanır.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export const MAX_ATTEMPTS = 3; // 3 hatalı denemeden sonra kilit
export const LOCK_MINUTES = 15; // 15 dakika sonra kendiliğinden açılır
export const ADMIN_ROLES = new Set(["admin", "superadmin"]);
export const ROLES = new Set(["admin", "superadmin", "satis", "resepsiyonist", "okuyucu"]);

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function admin(): SupabaseClient {
  return createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Supabase Auth'taki teknik e-posta: kullanıcı adı değişse bile sabit kalsın diye CRM id'sine bağlı.
export const authEmail = (crmUserId: number | string) => `u${crmUserId}@crm.turuncu.internal`;

// ---------- Şifre (index.html'deki PBKDF2 biçimiyle birebir uyumlu) ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(pwd: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(pwd: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return "$pbkdf2$" + b64(salt) + "$" + b64(await pbkdf2(pwd, salt));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// { ok, legacyPlain } — legacyPlain: şifre düz metin saklanıyormuş, hash'e çevrilmeli
export async function verifyPassword(pwd: string, stored: string | null) {
  if (!stored) return { ok: false, legacyPlain: false };
  if (!stored.startsWith("$pbkdf2$")) return { ok: timingSafeEqual(pwd, stored), legacyPlain: true };
  try {
    const [saltB64, hashB64] = stored.slice("$pbkdf2$".length).split("$");
    const got = b64(await pbkdf2(pwd, unb64(saltB64)));
    return { ok: timingSafeEqual(got, hashB64), legacyPlain: false };
  } catch {
    return { ok: false, legacyPlain: false };
  }
}

// Şifre kuralı: en az 8 karakter, en az 1 harf ve 1 rakam, kullanıcı adıyla aynı olamaz.
export function passwordProblem(pwd: string, username = ""): string | null {
  if (typeof pwd !== "string" || pwd.length < 8) return "Şifre en az 8 karakter olmalı.";
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(pwd) || !/\d/.test(pwd)) return "Şifre en az bir harf ve bir rakam içermeli.";
  if (username && pwd.toLocaleLowerCase("tr") === username.toLocaleLowerCase("tr")) {
    return "Şifre kullanıcı adıyla aynı olamaz.";
  }
  if (/^(12345678|password|sifre123|qwerty12|admin123|satis123)$/i.test(pwd)) return "Bu şifre çok yaygın, başka bir şifre seçin.";
  return null;
}

// Kullanıcının Supabase Auth hesabını oluşturur / rol-firma bilgisini günceller.
// Rol ve firma JWT içinde app_metadata olarak taşınır; RLS politikaları buna bakar.
export async function syncAuthUser(sb: SupabaseClient, u: any): Promise<string> {
  const app_metadata = {
    crm_user_id: u.id,
    crm_role: u.role,
    company_id: ADMIN_ROLES.has(u.role) ? null : (u.company_id ?? null),
  };
  if (u.auth_user_id) {
    const { error } = await sb.auth.admin.updateUserById(u.auth_user_id, { app_metadata, ban_duration: "none" });
    if (!error) return u.auth_user_id;
    // Auth hesabı silinmişse aşağıda yeniden oluşturulur
  }
  const { data, error } = await sb.auth.admin.createUser({
    email: authEmail(u.id),
    email_confirm: true,
    app_metadata,
    user_metadata: { username: u.username },
  });
  let id = data?.user?.id;
  if (error || !id) {
    // Aynı e-postayla zaten varsa onu bul
    const found = await findAuthUserByEmail(sb, authEmail(u.id));
    if (!found) throw new Error("Auth kullanıcısı oluşturulamadı: " + (error?.message ?? "bilinmeyen hata"));
    id = found;
    await sb.auth.admin.updateUserById(id, { app_metadata, ban_duration: "none" });
  }
  await sb.from("crm_users").update({ auth_user_id: id }).eq("id", u.id);
  return id;
}

async function findAuthUserByEmail(sb: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 100 });
    const hit = data?.users?.find((x) => x.email === email);
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 100) break;
  }
  return null;
}

// İstek sahibini JWT'den doğrular ve crm_users kaydını döner.
export async function callerFromRequest(req: Request, sb: SupabaseClient) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const crmId = data.user.app_metadata?.crm_user_id;
  if (crmId == null) return null;
  const { data: row } = await sb.from("crm_users").select("id,username,role,display_name,company_id,company_name,auth_user_id")
    .eq("id", crmId).maybeSingle();
  if (!row || row.auth_user_id !== data.user.id) return null;
  return row;
}

// Tarayıcıya dönen kullanıcı bilgisi (şifre hash'i ASLA dönmez)
export const publicUser = (u: any) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  display_name: u.display_name,
  company_id: u.company_id,
  company_name: u.company_name,
  locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
});
