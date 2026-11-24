-- Randevu kopyalarının temizliği
-- Eski "Tüm Firmalar" hatası yüzünden Luxark'ın (firma 2) 3 randevusu Turuncu Dental'in
-- (firma 1) satırına 6 kopya olarak yazılmıştı. Firma 1'in kendine ait randevusu yok.
-- Ayrıca kopyalar üzerinden yapılan silmeler asıl kayda (firma 2) ulaşmamıştı.

create schema if not exists backup;
create table if not exists backup.tasks_20261124_temizlik as select * from public.tasks;

-- 1) Firma 1'deki kopyaları kaldır (hepsi firma 2'deki kayıtların kopyası)
update public.tasks set data = '[]'::jsonb where id = 1;

-- 2) Firma 2'de silinmek istenen randevuları "silindi" olarak işaretle
--    1792272238787 = Lorraine Frost (23-24 Kasım'da silindi)
--    1792272212276 = David Frost   (kopyası üzerinden daha önce silinmişti) -- kullanıcı onayına göre
update public.tasks t set data = (
  select jsonb_agg(case when e->>'id' in ('1792272238787' /*, '1792272212276' */)
                        then e || '{"deleted": true}'::jsonb else e end order by o)
  from jsonb_array_elements(t.data) with ordinality x(e, o)
) where id = 2;

-- GERİ ALMA:
-- update public.tasks t set data = b.data from backup.tasks_20261124_temizlik b where b.id = t.id;
