-- Adım 1: sunucu taraflı giriş için crm_users tablosuna EK sütunlar.
-- Sadece EKLEME yapar; mevcut veriye ve mevcut CRM'in çalışmasına dokunmaz.
--   failed_attempts : art arda hatalı giriş sayısı (3 olunca 15 dk kilit)
--   locked_until    : kilidin açılacağı zaman
--   auth_user_id    : kullanıcının Supabase Auth hesabı (giriş kartı bu hesaba verilir)

alter table public.crm_users
  add column if not exists failed_attempts integer not null default 0,
  add column if not exists locked_until timestamptz,
  add column if not exists auth_user_id uuid unique;

-- GERİ ALMA (gerekirse SQL Editor'de çalıştırın):
-- alter table public.crm_users
--   drop column if exists failed_attempts,
--   drop column if exists locked_until,
--   drop column if exists auth_user_id;
-- Oluşan Auth hesapları: Supabase > Authentication > Users'ta
-- "@crm.turuncu.internal" ile biten kullanıcılar silinebilir (CRM'i etkilemez).
