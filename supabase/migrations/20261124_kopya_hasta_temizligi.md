# Kopya hasta temizliği — 24 Kasım 2026 (UYGULANDI)

Eski "Tüm Firmalar" kayıt hatası yüzünden 37 hasta kaydı hem firma 1 hem firma 2 satırında bulunuyordu.
(Herkese açık depo olduğu için hasta bilgisi yazılmamıştır.)

| Grup | Adet | Karar |
|---|---|---|
| Firma 2 event'lerine bağlı | 25 | Firma 2'nin hastası → firma 1 kopyası kaldırıldı (firma 2 kaydı daha güncel/aynı) |
| İki firmada da silinmiş | 11 | Firma 1 kopyası kaldırıldı |
| Event'siz test kaydı | 1 | Kullanıcı kararı: iki firmada da silindi olarak işaretlendi |

Sonuç: firma 1 = 117, firma 2 = 152 kayıt; ortak kayıt yok.
Yedek: crm_snapshots #269 (firma 1, temizlik öncesi) ve firma 2 snapshot'ı; ayrıca backup şemasında tam tablo yedeği.
