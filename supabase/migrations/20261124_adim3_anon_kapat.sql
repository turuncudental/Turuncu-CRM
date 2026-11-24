-- 24 Kasım 2026 13:5x'te ÇALIŞTIRILDI ("RLS ile çalıştır" seçeneğiyle: yedek tablolarda RLS açık). Sonuç: anon politikası kalmadı; anon anahtarla tüm tablolar boş liste döndürüyor.
-- Güvenlik Adım 3: "arka kapı"yı kapat – anon (herkese açık anahtar) erişimini kaldır.
--
-- ÖN KOŞUL: Yeni giriş sistemli sayfa ana adreste yayında (PR #119) ve en az bir
-- admin girişi + veri okuma/yazma test edilmiş olmalı. Bu dosyadan sonra eski
-- sayfa (açık kalmış sekmeler) veri göremez; sayfa yenilenip tekrar giriş yapılmalı.
--
-- Etkilenmeyenler: meta-leads / crm-login / crm-users (service role ile çalışır),
-- Supabase Keepalive (crm_companies okur; anon artık boş liste alır ama yine 200 döner).

-- 1) YEDEK: PostgREST'e açık olmayan ayrı bir şemaya (dışarıdan okunamaz)
create schema if not exists backup;
revoke all on schema backup from anon, authenticated;
create table if not exists backup.customers_20261124     as select * from public.customers;
create table if not exists backup.deals_20261124         as select * from public.deals;
create table if not exists backup.tasks_20261124         as select * from public.tasks;
create table if not exists backup.history_20261124       as select * from public.history;
create table if not exists backup.crm_companies_20261124 as select * from public.crm_companies;
create table if not exists backup.crm_users_20261124     as select * from public.crm_users;

-- 2) Herkese açık politikaları kaldır
drop policy if exists anon_all    on public.customers;
drop policy if exists anon_all    on public.deals;
drop policy if exists anon_all    on public.tasks;
drop policy if exists anon_all    on public.history;
drop policy if exists anon_all    on public.crm_companies;
drop policy if exists anon_all    on public.crm_logs;
drop policy if exists anon_all    on public.crm_snapshots;
drop policy if exists anon_select on public.crm_users;   -- şifre hash'leri artık dışarıdan okunamaz

-- 3) Hasta dosyası yükleme: sadece giriş yapmış kullanıcılar
drop policy if exists patient_files_insert on storage.objects;
create policy patient_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'patient-files');

-- 4) Kontrol: public şemada anon'a açık politika kalmamalı
select tablename, policyname, roles::text from pg_policies
where schemaname in ('public', 'storage') and 'anon' = any(roles);

-- ================= GERİ ALMA (acil durumda, eski sayfayı tekrar çalıştırmak için) =================
-- create policy anon_all on public.customers     for all to anon using (true) with check (true);
-- create policy anon_all on public.deals         for all to anon using (true) with check (true);
-- create policy anon_all on public.tasks         for all to anon using (true) with check (true);
-- create policy anon_all on public.history       for all to anon using (true) with check (true);
-- create policy anon_all on public.crm_companies for all to anon using (true) with check (true);
-- create policy anon_all on public.crm_logs      for all to anon using (true) with check (true);
-- create policy anon_all on public.crm_snapshots for all to anon using (true) with check (true);
-- create policy anon_select on public.crm_users  for select to anon using (true);
-- drop policy if exists patient_files_insert on storage.objects;
-- create policy patient_files_insert on storage.objects for insert to anon, authenticated
--   with check (bucket_id = 'patient-files');
--
-- Veri geri yükleme (yalnızca veri bozulursa), örnek:
-- update public.customers c set data = b.data from backup.customers_20261124 b where b.id = c.id;
