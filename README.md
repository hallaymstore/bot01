# @Test01uzbot — File Utility Bot

Oddiy va foydali Telegram fayl utility bot.

## Funksiyalar

- 🖼 JPG/PNG rasmlarni PDF qilish
- 📚 Bir nechta PDF faylni birlashtirish
- 🗜 Bir nechta fayldan ZIP yaratish
- ✏️ Fayl nomini o‘zgartirish
- ℹ️ Fayl nomi, MIME turi, hajmi va Telegram unique ID ko‘rsatish
- `/cancel`, `/done`, `/help`
- Render uchun `/health` endpoint
- `ADMIN_ID` o‘rnatilsa `/stats` admin statistikasi

## Environment variables

- `BOT_TOKEN` — majburiy
- `ADMIN_ID` — ixtiyoriy Telegram numeric user ID
- `PORT` — Render avtomatik beradi

## Ishga tushirish

```bash
npm install
npm start
```

> Tokenni GitHub kodiga yozmang. Render Environment Variables orqali saqlang.
