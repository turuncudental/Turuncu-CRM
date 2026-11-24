-- Eşzamanlı kayıt: aynı firmada birden fazla kullanıcı aynı anda çalışabilsin.
-- Sayfa artık tüm listeyi değil, yalnızca değişen kayıtları gönderir. Bu fonksiyon onları
-- mevcut listeye ATOMİK olarak birleştirir: önce firma satırı kilitlenir (SELECT ... FOR UPDATE),
-- eşzamanlı yazmalar sıraya girer ve her biri bir öncekinin sonucunun üzerine uygulanır.
--
--   p_upserts    : değişen / yeni kayıtlar (id'ye göre değiştirilir, yoksa sona eklenir)
--   p_remove_ids : listeden tamamen çıkarılacak kayıt id'leri
-- Güvenlik: security invoker -> tablo izinleri (RLS) aynen geçerli; sadece kendi firması / admin.

create or replace function public.crm_merge_items(
  p_table text, p_company integer, p_upserts jsonb, p_remove_ids jsonb default '[]'::jsonb
) returns integer
  language plpgsql security invoker set search_path = public
as $$
declare
  cur_data jsonb;
  new_data jsonb;
  n integer;
  rc integer;
begin
  if p_table not in ('customers', 'deals', 'tasks') then
    raise exception 'crm_merge_items: izin verilmeyen tablo %', p_table;
  end if;
  p_upserts := coalesce(p_upserts, '[]'::jsonb);
  p_remove_ids := coalesce(p_remove_ids, '[]'::jsonb);
  if jsonb_typeof(p_upserts) <> 'array' or jsonb_typeof(p_remove_ids) <> 'array' then
    raise exception 'crm_merge_items: dizi bekleniyordu';
  end if;

  -- 1) Firma satırını kilitle (diğer yazmalar burada bekler)
  -- (EXECUTE, FOUND değişkenini güncellemez; ROW_COUNT kullanılır)
  execute format('select data from public.%I where id = $1 for update', p_table)
    into cur_data using p_company;
  get diagnostics rc = row_count;
  if rc = 0 then
    execute format('insert into public.%I (id, data) values ($1, ''[]''::jsonb) on conflict (id) do nothing', p_table)
      using p_company;
    execute format('select data from public.%I where id = $1 for update', p_table)
      into cur_data using p_company;
    get diagnostics rc = row_count;
    if rc = 0 then
      raise exception 'crm_merge_items: yazma izni yok (firma %)', p_company using errcode = '42501';
    end if;
  end if;
  cur_data := coalesce(cur_data, '[]'::jsonb);

  -- 2) Birleştir: mevcut sıra korunur, değişenler yenisiyle, silinecekler çıkar, yeniler sona
  with cur as (select e, o from jsonb_array_elements(cur_data) with ordinality x(e, o)),
       up  as (select e, o from jsonb_array_elements(p_upserts) with ordinality y(e, o)),
       upl as (select distinct on (e->>'id') e->>'id' id, e, o from up where e->>'id' is not null order by e->>'id', o desc),
       rm  as (select jsonb_array_elements_text(p_remove_ids) id)
  select coalesce(jsonb_agg(v order by grp, ord), '[]'::jsonb) into new_data from (
    select coalesce(u.e, c.e) v, 0 grp, c.o ord
      from cur c left join upl u on u.id = c.e->>'id'
     where c.e->>'id' is null or c.e->>'id' not in (select id from rm)
    union all
    select u.e, 1, u.o from upl u
     where not exists (select 1 from cur c where c.e->>'id' = u.id)
       and u.id not in (select id from rm)
  ) z;

  -- 3) Yaz
  execute format('update public.%I set data = $2 where id = $1 returning jsonb_array_length(data)', p_table)
    into n using p_company, new_data;
  if n is null then
    raise exception 'crm_merge_items: yazma izni yok (firma %)', p_company using errcode = '42501';
  end if;
  return n;
end $$;

revoke execute on function public.crm_merge_items(text, integer, jsonb, jsonb) from public, anon;
grant execute on function public.crm_merge_items(text, integer, jsonb, jsonb) to authenticated;

-- GERİ ALMA: drop function if exists public.crm_merge_items(text, integer, jsonb, jsonb);
-- (ve sayfa PR'ı revert edilir; eski sayfa tüm listeyi PATCH ile yazar)
