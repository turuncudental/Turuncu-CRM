# Meta Leads → CRM Kurulum Talimatı

## 1. Supabase CLI Kur (bir kez)

```bash
npm install -g supabase
supabase login
supabase link --project-ref abtmfoetnhswccliuawn
```

## 2. Gerekli Supabase Secret'ları Ekle

Supabase Dashboard → Project → Edge Functions → Secrets bölümünden:

| Key | Değer |
|-----|-------|
| `META_VERIFY_TOKEN` | Kendi belirlediğin şifre (örn: `turuncu_meta_2024`) |
| `META_ACCESS_TOKEN` | Meta Business → System User → Access Token |
| `COMPANY_ID` | `1` (varsayılan şirket ID) |

> `SUPABASE_URL` ve `SUPABASE_SERVICE_ROLE_KEY` Edge Function'larda otomatik gelir, eklemeye gerek yok.

## 3. Edge Function'ı Deploy Et

```bash
supabase functions deploy meta-leads --no-verify-jwt
```

Deploy sonrası webhook URL'in:
```
https://abtmfoetnhswccliuawn.supabase.co/functions/v1/meta-leads
```

## 4. Meta Business'ta Webhook Kur

1. [developers.facebook.com](https://developers.facebook.com) → Uygulamanı aç
2. **Webhooks** → **Leadgen** subscribe et
3. Callback URL: `https://abtmfoetnhswccliuawn.supabase.co/functions/v1/meta-leads`
4. Verify Token: `META_VERIFY_TOKEN` olarak girdiğin şifre
5. **Verify and Save** tıkla → Edge Function GET isteğini doğrular

## 5. Test Et

Meta Lead Ads Manager → Test Lead gönder → CRM'i yenile → yeni hasta "lead" statüsünde görünmeli.

## Leadler CRM'de Nasıl Görünür?

- **Durum:** `lead` (sarı etiket)
- **Kaynak:** `Meta Ads`
- Reklam adı, kampanya ID'si hasta notlarına eklenir
- Tarih: lead'in geldiği gün
