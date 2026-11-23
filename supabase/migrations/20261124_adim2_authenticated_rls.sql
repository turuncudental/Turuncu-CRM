-- Güvenlik Adım 2: giriş yapmış kullanıcılar (rol: authenticated) için firma bazlı izinler.
--
-- Bu dosya SADECE EKLEME yapar. Mevcut "anon_all" politikaları yerinde kalır, yani
-- eski sürüm sayfa (önbellekte kalmış bir sekme) çalışmaya devam eder.
-- Anon politikaları Adım 3'te, herkes yeni girişe geçtikten sonra kaldırılacak.
--
-- Kurallar (token içindeki app_metadata'dan okunur, crm-login fonksiyonu yazar):
--   admin / superadmin  -> tüm firmalar
--   diğer roller        -> yalnızca kendi firması (satır id'si = firma id'si)
--   okuyucu             -> sadece okuma
--   kullanıcı silme/ekleme -> sadece crm-users fonksiyonu (crm_users tablosuna istemciden erişim yok)

create or replace function public.crm_claim(k text) returns text
  language sql stable set search_path = public
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> k, '') $$;

create or replace function public.crm_is_admin() returns boolean
  language sql stable set search_path = public
as $$ select public.crm_claim('crm_role') in ('admin', 'superadmin') $$;

create or replace function public.crm_company() returns integer
  language sql stable set search_path = public
as $$ select nullif(public.crm_claim('company_id'), '')::integer $$;

create or replace function public.crm_can_write() returns boolean
  language sql stable set search_path = public
as $$ select public.crm_claim('crm_role') not in ('', 'okuyucu') $$;

-- ---- Firma verisi tabloları: satır id'si = firma id'si ----
do $$
declare t text;
begin
  foreach t in array array['customers', 'deals', 'tasks', 'history'] loop
    execute format('drop policy if exists auth_select on public.%I', t);
    execute format('drop policy if exists auth_insert on public.%I', t);
    execute format('drop policy if exists auth_update on public.%I', t);
    execute format('drop policy if exists auth_delete on public.%I', t);
    execute format($p$create policy auth_select on public.%I for select to authenticated
      using (public.crm_is_admin() or id = public.crm_company())$p$, t);
    execute format($p$create policy auth_insert on public.%I for insert to authenticated
      with check (public.crm_can_write() and (public.crm_is_admin() or id = public.crm_company()))$p$, t);
    execute format($p$create policy auth_update on public.%I for update to authenticated
      using (public.crm_can_write() and (public.crm_is_admin() or id = public.crm_company()))
      with check (public.crm_can_write() and (public.crm_is_admin() or id = public.crm_company()))$p$, t);
    execute format($p$create policy auth_delete on public.%I for delete to authenticated
      using (public.crm_is_admin())$p$, t);
  end loop;
end $$;

-- ---- Firmalar: herkes kendi firmasını görür, sadece admin değiştirir ----
drop policy if exists auth_select on public.crm_companies;
drop policy if exists auth_write on public.crm_companies;
create policy auth_select on public.crm_companies for select to authenticated
  using (public.crm_is_admin() or id = public.crm_company());
create policy auth_write on public.crm_companies for all to authenticated
  using (public.crm_is_admin()) with check (public.crm_is_admin());

-- ---- İşlem kayıtları (log): kendi firmasına yazar/okur, admin hepsini okur. Silme/değiştirme yok ----
drop policy if exists auth_select on public.crm_logs;
drop policy if exists auth_insert on public.crm_logs;
create policy auth_select on public.crm_logs for select to authenticated
  using (public.crm_is_admin() or company_id = public.crm_company());
create policy auth_insert on public.crm_logs for insert to authenticated
  with check (public.crm_is_admin() or company_id = public.crm_company());

-- ---- Otomatik yedekler (snapshot): kendi firması; admin hepsi ----
drop policy if exists auth_all on public.crm_snapshots;
create policy auth_all on public.crm_snapshots for all to authenticated
  using (public.crm_is_admin() or company_id = public.crm_company())
  with check (public.crm_is_admin() or company_id = public.crm_company());

-- crm_users: authenticated için politika YOK (bilerek). Kullanıcı işlemleri crm-users fonksiyonundan.

-- ================= GERİ ALMA =================
-- do $$ declare t text; begin
--   foreach t in array array['customers','deals','tasks','history'] loop
--     execute format('drop policy if exists auth_select on public.%I', t);
--     execute format('drop policy if exists auth_insert on public.%I', t);
--     execute format('drop policy if exists auth_update on public.%I', t);
--     execute format('drop policy if exists auth_delete on public.%I', t);
--   end loop; end $$;
-- drop policy if exists auth_select on public.crm_companies;
-- drop policy if exists auth_write on public.crm_companies;
-- drop policy if exists auth_select on public.crm_logs;
-- drop policy if exists auth_insert on public.crm_logs;
-- drop policy if exists auth_all on public.crm_snapshots;
-- drop function if exists public.crm_can_write(), public.crm_company(), public.crm_is_admin(), public.crm_claim(text);
