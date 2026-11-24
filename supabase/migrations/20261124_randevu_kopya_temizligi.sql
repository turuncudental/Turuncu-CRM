-- 24 Kasım 2026'da ÇALIŞTIRILDI.
-- Randevu kopyalarının temizliği: eski "Tüm Firmalar" hatası yüzünden Luxark'ın (firma 2)
-- 3 randevusu Turuncu Dental'in (firma 1) satırına 6 kopya olarak yazılmıştı.
-- Lorraine Frost ve David Frost randevuları kullanıcı tarafından (düzeltilmiş sayfadan)
-- firma 2'de zaten silindi olarak işaretlendi.

create table if not exists backup.tasks_20261124_temizlik as select * from public.tasks;
alter table backup.tasks_20261124_temizlik enable row level security;
-- Firma 1'de yalnızca firma 2'de de bulunan kayıtlar varsa temizle (güvenlik koşulu)
update public.tasks set data = '[]'::jsonb
 where id = 1
   and not exists (select 1 from jsonb_array_elements(data) e
                   where e->>'id' not in (select x->>'id' from public.tasks t2, jsonb_array_elements(t2.data) x where t2.id = 2));

-- GERİ ALMA:
-- update public.tasks t set data = b.data from backup.tasks_20261124_temizlik b where b.id = t.id;
