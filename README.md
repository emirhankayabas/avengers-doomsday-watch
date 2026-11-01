# Avengers: Doomsday ön satış bildirimi

World Cinezone sitesini 20-30 saniyede bir kontrol eder. Avengers: Doomsday göründüğü an
Telegram'a posterli mesaj ve ntfy'a acil bildirim gönderir; Telegram botuna bir şey yazılana
kadar her dakika hatırlatır.

GitHub Actions'ta `.github/workflows/watch.yml` ile 7/24 çalışır. Gerekli secrets:
`TG_TOKEN`, `TG_CHAT`, `NTFY_TOPIC`. Film bulununca workflow kendini kapatır.
