-- 24 Kasım 2026'da ÇALIŞTIRILDI.
-- 23 Kasım'da meta-leads v3 yayına girmeden önce gelen 7 Meta lead'i (Ramsgate/Dartford
-- kampanyaları) yanlışlıkla Turuncu Dental'e (firma 1) event'siz düşmüştü. Luxark'a
-- (firma 2) taşındı; kampanya adındaki şehre göre otomatik oluşturulan event'e bağlandı.
-- Not: bu lead'lerde e-posta eski kod yüzünden boş; Meta Lead Center'dan kontrol edilmeli.

create table if not exists backup.customers_20261124_lead_tasima as select * from public.customers;
alter table backup.customers_20261124_lead_tasima enable row level security;

with ev as (select e->>'id' id, e->>'name' name from deals d, jsonb_array_elements(d.data) e
            where d.id = 2 and e->>'autoCreated' = 'true' and coalesce(e->>'deleted', 'false') <> 'true'),
mv as (select e || jsonb_build_object(
                 'eventId', (select ev.id::bigint from ev
                             where ev.name = trim(regexp_replace(split_part(e->>'campaignName', '|', 1), '\s*Event\s*', '', 'i'))),
                 'notes', jsonb_build_array(jsonb_build_object(
                   'text', 'Turuncu Dental''den Luxark''a taşındı (kampanyaya göre event atandı). E-posta Meta''dan kontrol edilmeli.',
                   'date', now()::text))) e
       from customers c, jsonb_array_elements(c.data) e
       where c.id = 1 and e->>'source' = 'Meta Ads' and e->>'createdAt' >= '2026-11-23'
         and not exists (select 1 from customers c2, jsonb_array_elements(c2.data) x
                         where c2.id = 2 and x->>'metaLeadId' = e->>'metaLeadId'))
update public.customers set data = data || coalesce((select jsonb_agg(e) from mv), '[]'::jsonb) where id = 2;

update public.customers c set data = (
  select coalesce(jsonb_agg(e order by o), '[]'::jsonb)
  from jsonb_array_elements(c.data) with ordinality x(e, o)
  where not (e->>'source' = 'Meta Ads' and e->>'createdAt' >= '2026-11-23'
             and exists (select 1 from customers c2, jsonb_array_elements(c2.data) y
                         where c2.id = 2 and y->>'metaLeadId' = e->>'metaLeadId')))
where id = 1;

-- GERİ ALMA:
-- update public.customers c set data = b.data from backup.customers_20261124_lead_tasima b where b.id = c.id;
