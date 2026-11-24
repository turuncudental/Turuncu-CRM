-- Hasta dosyaları klasörünü (patient-files) kilitle.
-- Önce: klasör "public" -> linki bilen herkes röntgen/fotoğrafları açabiliyordu.
-- Sonra: sadece giriş yapmış kullanıcılar, yalnızca kendi firmasının hastalarının dosyalarına
--        1 saat geçerli imzalı linklerle erişir (admin hepsine).
-- Dosya yolu: <hasta_id>/<zaman>_<dosya_adı>

-- ===== A) İzinler (sayfa güncellemesinden ÖNCE çalıştırılır; mevcut erişimi bozmaz) =====
create or replace function public.crm_patient_ok(pid text) returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.crm_is_admin()
      or exists (select 1 from public.customers c, jsonb_array_elements(c.data) e
                 where c.id = public.crm_company() and e->>'id' = pid)
$$;
revoke execute on function public.crm_patient_ok(text) from public, anon;
grant execute on function public.crm_patient_ok(text) to authenticated;

drop policy if exists patient_files_select on storage.objects;
create policy patient_files_select on storage.objects for select to authenticated
  using (bucket_id = 'patient-files' and public.crm_patient_ok(split_part(name, '/', 1)));

drop policy if exists patient_files_update on storage.objects;
create policy patient_files_update on storage.objects for update to authenticated
  using (bucket_id = 'patient-files' and public.crm_patient_ok(split_part(name, '/', 1)))
  with check (bucket_id = 'patient-files' and public.crm_patient_ok(split_part(name, '/', 1)));

drop policy if exists patient_files_delete on storage.objects;
create policy patient_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'patient-files' and public.crm_patient_ok(split_part(name, '/', 1)));
-- (patient_files_insert: Adım 3'te zaten yalnızca authenticated)

-- ===== B) Klasörü gizli yap (sayfa güncellemesi yayına girdikten SONRA) =====
-- update storage.buckets set public = false where id = 'patient-files';

-- ===== GERİ ALMA =====
-- update storage.buckets set public = true where id = 'patient-files';
-- drop policy if exists patient_files_select on storage.objects;
-- drop policy if exists patient_files_update on storage.objects;
-- drop policy if exists patient_files_delete on storage.objects;
-- drop function if exists public.crm_patient_ok(text);
