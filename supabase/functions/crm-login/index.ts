// Turuncu CRM – sunucu taraflı giriş (Supabase Edge Function: crm-login)
//
// POST { username, password }
//  -> 200 { session: { access_token, refresh_token, expires_at }, user }
//  -> 401 { error: "invalid", remaining }       hatalı kullanıcı adı / şifre
//  -> 423 { error: "locked", minutes }          3 hatalı denemeden sonra 15 dk kilit
//
// Şifre veritabanındaki PBKDF2 hash'iyle SUNUCUDA karşılaştırılır; tarayıcı hash'i hiç görmez.
// Başarılı girişte kullanıcıya Supabase Auth oturumu (imzalı JWT) verilir. Rol ve firma
// JWT'nin app_metadata alanındadır; veritabanı izinleri (RLS) buna göre çalışır.
// Deploy: --no-verify-jwt (giriş öncesi token yok)

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  admin, ANON_KEY, authEmail, cors, hashPassword, json, LOCK_MINUTES, MAX_ATTEMPTS, publicUser, SUPA_URL,
  syncAuthUser, verifyPassword,
} from "../_shared/crm.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let username = "", password = "";
  try {
    const b = await req.json();
    username = String(b.username ?? "").trim();
    password = String(b.password ?? "");
  } catch { /* boş gövde */ }
  if (!username || !password) return json({ error: "invalid", remaining: null }, 401);

  const sb = admin();
  const { data: u, error } = await sb.from("crm_users")
    .select("id,username,password,role,display_name,company_id,company_name,failed_attempts,locked_until,auth_user_id")
    .eq("username", username).maybeSingle();
  if (error) {
    console.error("crm_users okunamadı:", error.message);
    return json({ error: "server" }, 500);
  }

  // Kullanıcı yoksa da aynı yanıt (kullanıcı adı tahmini yapılamasın) + sabit gecikme
  if (!u) {
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: "invalid", remaining: null }, 401);
  }

  const now = Date.now();
  const lockedUntil = u.locked_until ? new Date(u.locked_until).getTime() : 0;
  if (lockedUntil > now) {
    return json({ error: "locked", minutes: Math.ceil((lockedUntil - now) / 60000) }, 423);
  }

  const { ok, legacyPlain } = await verifyPassword(password, u.password);
  if (!ok) {
    // Kilit süresi dolmuşsa sayaç sıfırdan başlar
    const prev = lockedUntil && lockedUntil <= now ? 0 : (u.failed_attempts ?? 0);
    const attempts = prev + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const until = new Date(now + LOCK_MINUTES * 60000).toISOString();
      await sb.from("crm_users").update({ failed_attempts: 0, locked_until: until }).eq("id", u.id);
      await sb.from("crm_logs").insert({
        company_id: u.company_id, company_name: u.company_name ?? "—", username: u.username,
        display_name: u.display_name ?? u.username, action: "login_locked", detail: `${MAX_ATTEMPTS} hatalı deneme`,
      });
      return json({ error: "locked", minutes: LOCK_MINUTES }, 423);
    }
    await sb.from("crm_users").update({ failed_attempts: attempts, locked_until: null }).eq("id", u.id);
    return json({ error: "invalid", remaining: MAX_ATTEMPTS - attempts }, 401);
  }

  // Başarılı: sayaçları sıfırla, düz metin şifre kaldıysa hash'e çevir
  const patch: Record<string, unknown> = { failed_attempts: 0, locked_until: null };
  if (legacyPlain) patch.password = await hashPassword(password);
  await sb.from("crm_users").update(patch).eq("id", u.id);

  try {
    await syncAuthUser(sb, u);
    // Şifresiz, tek kullanımlık giriş bağlantısı üret ve hemen sunucuda kullan -> oturum
    const { data: link, error: le } = await sb.auth.admin.generateLink({ type: "magiclink", email: authEmail(u.id) });
    if (le || !link?.properties?.hashed_token) throw new Error(le?.message ?? "link üretilemedi");
    const anon = createClient(SUPA_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: v, error: ve } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
    if (ve || !v?.session) throw new Error(ve?.message ?? "oturum açılamadı");

    return json({
      session: {
        access_token: v.session.access_token,
        refresh_token: v.session.refresh_token,
        expires_at: v.session.expires_at,
      },
      user: publicUser(u),
    });
  } catch (e) {
    console.error("Oturum oluşturma hatası:", e);
    return json({ error: "server" }, 500);
  }
});
