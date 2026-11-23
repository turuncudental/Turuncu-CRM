// Turuncu CRM – kullanıcı yönetimi (Supabase Edge Function: crm-users)
//
// Tüm istekler giriş yapmış kullanıcının token'ıyla gelir (Authorization: Bearer <access_token>).
// POST { action, ... }
//   list                                   (admin)  kullanıcı listesi – şifre hash'i dönmez
//   create  { username, password, role, display_name, company_id }   (admin)
//   update  { id, display_name, role, company_id, password? }        (admin)
//   delete  { id }                         (admin)  kendi hesabını silemez
//   unlock  { id }                         (admin)  kilitli hesabı hemen açar
//   rename_company { company_id, name }    (admin)  kullanıcıların firma adını günceller
//   change_password { current, new }       (herkes) kendi şifresini değiştirir
//
// Şifre kuralı: en az 8 karakter, harf + rakam, kullanıcı adıyla aynı olamaz.
// Deploy: JWT doğrulaması AÇIK (varsayılan).

import {
  admin, ADMIN_ROLES, callerFromRequest, cors, hashPassword, json, passwordProblem, publicUser, ROLES,
  syncAuthUser, verifyPassword,
} from "../_shared/crm.ts";

const COLS = "id,username,role,display_name,company_id,company_name,locked_until,auth_user_id";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const sb = admin();
  const me = await callerFromRequest(req, sb);
  if (!me) return json({ error: "unauthorized" }, 401);

  let b: any = {};
  try { b = await req.json(); } catch { /* */ }
  const action = String(b.action ?? "");
  const isAdmin = ADMIN_ROLES.has(me.role);

  const log = (act: string, detail: string) =>
    sb.from("crm_logs").insert({
      company_id: me.company_id, company_name: me.company_name ?? "—", username: me.username,
      display_name: me.display_name ?? me.username, action: act, detail: detail.substring(0, 200),
    });

  // ---- herkes: kendi şifresini değiştir ----
  if (action === "change_password") {
    const { data: row } = await sb.from("crm_users").select("password").eq("id", me.id).single();
    const { ok } = await verifyPassword(String(b.current ?? ""), row?.password ?? null);
    if (!ok) return json({ error: "Mevcut şifre yanlış." }, 400);
    const prob = passwordProblem(String(b.new ?? ""), me.username);
    if (prob) return json({ error: prob }, 400);
    await sb.from("crm_users").update({ password: await hashPassword(String(b.new)) }).eq("id", me.id);
    await log("password_change", "");
    return json({ ok: true });
  }

  if (!isAdmin) return json({ error: "forbidden" }, 403);

  const companyName = async (cid: unknown) => {
    if (cid == null || cid === "") return null;
    const { data } = await sb.from("crm_companies").select("name").eq("id", Number(cid)).maybeSingle();
    return data?.name ?? null;
  };

  switch (action) {
    case "list": {
      const { data, error } = await sb.from("crm_users").select(COLS).order("id");
      if (error) return json({ error: error.message }, 500);
      return json({ users: (data ?? []).map(publicUser) });
    }

    case "create": {
      const username = String(b.username ?? "").trim();
      const role = String(b.role ?? "satis");
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return json({ error: "Kullanıcı adı 3-32 karakter olmalı (harf, rakam, . _ -)." }, 400);
      }
      if (!ROLES.has(role)) return json({ error: "Geçersiz rol." }, 400);
      const prob = passwordProblem(String(b.password ?? ""), username);
      if (prob) return json({ error: prob }, 400);
      const isAdminRole = ADMIN_ROLES.has(role);
      const cid = isAdminRole ? null : (b.company_id != null && b.company_id !== "" ? Number(b.company_id) : null);
      if (!isAdminRole && cid == null) return json({ error: "Firma seçilmeli." }, 400);
      const { data: exists } = await sb.from("crm_users").select("id").eq("username", username).maybeSingle();
      if (exists) return json({ error: "Bu kullanıcı adı zaten var." }, 400);
      const { data: row, error } = await sb.from("crm_users").insert({
        username, role,
        password: await hashPassword(String(b.password)),
        display_name: b.display_name || null,
        company_id: cid,
        company_name: await companyName(cid),
      }).select(COLS).single();
      if (error) return json({ error: error.message }, 400);
      await syncAuthUser(sb, row);
      await log("user_add", `${row.display_name || username}${row.company_name ? ` (${row.company_name})` : ""}`);
      return json({ user: publicUser(row) });
    }

    case "update": {
      const id = Number(b.id);
      const { data: cur } = await sb.from("crm_users").select(COLS).eq("id", id).maybeSingle();
      if (!cur) return json({ error: "Kullanıcı bulunamadı." }, 404);
      const role = b.role != null ? String(b.role) : cur.role;
      if (!ROLES.has(role)) return json({ error: "Geçersiz rol." }, 400);
      if (id === me.id && !ADMIN_ROLES.has(role)) return json({ error: "Kendi admin yetkinizi kaldıramazsınız." }, 400);
      const isAdminRole = ADMIN_ROLES.has(role);
      const cid = isAdminRole ? null
        : (b.company_id !== undefined ? (b.company_id === "" || b.company_id == null ? null : Number(b.company_id))
          : cur.company_id);
      if (!isAdminRole && cid == null) return json({ error: "Firma seçilmeli." }, 400);
      const upd: Record<string, unknown> = {
        role,
        display_name: b.display_name !== undefined ? (b.display_name || null) : cur.display_name,
        company_id: cid,
        company_name: await companyName(cid),
      };
      if (b.password) {
        const prob = passwordProblem(String(b.password), cur.username);
        if (prob) return json({ error: prob }, 400);
        upd.password = await hashPassword(String(b.password));
        upd.failed_attempts = 0;
        upd.locked_until = null;
      }
      const { data: row, error } = await sb.from("crm_users").update(upd).eq("id", id).select(COLS).single();
      if (error) return json({ error: error.message }, 400);
      await syncAuthUser(sb, row); // yeni rol/firma bir sonraki token yenilemede geçerli olur
      await log("user_edit", row.display_name || row.username);
      return json({ user: publicUser(row) });
    }

    case "delete": {
      const id = Number(b.id);
      if (id === me.id) return json({ error: "Kendi hesabınızı silemezsiniz." }, 400);
      const { data: cur } = await sb.from("crm_users").select(COLS).eq("id", id).maybeSingle();
      if (!cur) return json({ error: "Kullanıcı bulunamadı." }, 404);
      // Auth hesabı silinince o kişinin açık oturumları da yenilenemez -> en geç 1 saat içinde düşer
      if (cur.auth_user_id) await sb.auth.admin.deleteUser(cur.auth_user_id);
      const { error } = await sb.from("crm_users").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      await log("user_delete", cur.display_name || cur.username);
      return json({ ok: true });
    }

    case "unlock": {
      const id = Number(b.id);
      await sb.from("crm_users").update({ failed_attempts: 0, locked_until: null }).eq("id", id);
      await log("user_unlock", String(id));
      return json({ ok: true });
    }

    case "rename_company": {
      const cid = Number(b.company_id);
      const name = String(b.name ?? "").trim();
      if (!cid || !name) return json({ error: "Eksik bilgi." }, 400);
      await sb.from("crm_users").update({ company_name: name }).eq("company_id", cid);
      return json({ ok: true });
    }

    default:
      return json({ error: "unknown action" }, 400);
  }
});
