// World Cinezone - Avengers: Doomsday ön satış bildirimi
// Yerelde çalıştır: node avengers-watch.mjs  (.env dosyası gerekir)
// GitHub Actions'ta .github/workflows/watch.yml ile otomatik çalışır.
//
// Film bulununca: posterli Telegram mesajı + ntfy ACİL bildirimi (uzun titreşim + ses).
// Sen Telegram botuna herhangi bir mesaj ("tamam" vb.) yazana kadar:
//   her 1 dakikada Telegram mesajı + ntfy acil bildirimi tekrarlanır (en fazla 2 saat).

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Gizli bilgiler ortam değişkenlerinden okunur (GitHub Secrets ya da yerelde .env dosyası)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { TG_TOKEN, TG_CHAT, NTFY_TOPIC } = process.env;
if (!TG_TOKEN || !TG_CHAT || !NTFY_TOPIC) {
  console.error("TG_TOKEN, TG_CHAT ve NTFY_TOPIC tanımlı olmalı (.env ya da GitHub Secrets).");
  process.exit(1);
}
// Birden fazla kişi: TG_CHAT=111,222
const TG_CHATS = TG_CHAT.split(",").map((s) => s.trim()).filter(Boolean);

// GitHub Actions'ta her çalışma bu kadar dakika kontrol eder, sonra yerini bir sonrakine bırakır.
// Yerelde tanımlanmazsa sınırsız çalışır.
const MAX_RUNTIME_MIN = Number(process.env.MAX_RUNTIME_MIN || 0);
const STARTED_AT = Date.now();

const FILM_NAME = "AVENGERS: DOOMSDAY";
const RE = /avengers|doomsday|k[iı]yamet/gi;

const BASE = "https://www.worldcinezone.com.tr";
// Ön satıştaki filmler ana sayfada görünüyor; tek sayfa yeterli
const PAGES = [{ name: "Ana sayfa", url: `${BASE}/` }];

const MIN_WAIT = 55000; // kontrol aralığı: ~1 dk (55-65 sn)
const MAX_WAIT = 65000;
const REMIND_EVERY = 60 * 1000; // hatırlatma mesajı: 1 dk
const REMIND_MAX = 2 * 60 * 60 * 1000; // en fazla 2 saat

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("tr-TR");

const tg = (method, body = {}) =>
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const sendOne = async (chat_id, text) => {
  const res = await tg("sendMessage", { chat_id, text });
  if (!res.ok) console.error(`Telegram hatası (${chat_id}):`, await res.text());
};
const sendText = (text) => Promise.all(TG_CHATS.map((id) => sendOne(id, text)));

// Poster varsa resimli gönder, olmazsa düz mesaja düş
const notify = (text, poster) =>
  Promise.all(
    TG_CHATS.map(async (chat_id) => {
      if (poster) {
        const res = await tg("sendPhoto", { chat_id, photo: poster, caption: text });
        if (res.ok) return;
        console.error(`Poster gönderilemedi (${chat_id}), düz mesaj atılıyor:`, await res.text());
      }
      await sendOne(chat_id, text);
    })
  );

// ntfy acil bildirimi (ücretsiz, hesap gerekmez)
const urgent = async (title, message, click, attach) => {
  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title,
        message,
        priority: 5,
        tags: ["rotating_light"],
        ...(click ? { click } : {}),
        ...(attach ? { attach } : {}),
      }),
    });
    if (!res.ok) console.error(now(), "ntfy hatası:", await res.text());
    else console.log(now(), "ntfy acil bildirimi gönderildi");
  } catch (e) {
    console.error(now(), "ntfy hatası:", e.message);
  }
};

// Bota gelen son mesajın id'si (bundan sonra gelen mesaj = "gördüm" demek)
const lastUpdateId = async () => {
  try {
    const j = await (await tg("getUpdates", { offset: -1, timeout: 0 })).json();
    return j.result?.at(-1)?.update_id ?? 0;
  } catch {
    return 0;
  }
};

// Listeden herhangi biri yazarsa onun adını döndürür
const userReplied = async (afterId) => {
  try {
    const j = await (await tg("getUpdates", { offset: afterId + 1, timeout: 0 })).json();
    const u = (j.result ?? []).find((u) => TG_CHATS.includes(String(u.message?.chat?.id)));
    return u ? u.message.from?.first_name || "Biri" : null;
  } catch {
    return null;
  }
};

// Eşleşmenin yakınındaki /film/123 linkini ve "Ön Satış" yazısını bul
function findFilm(html) {
  RE.lastIndex = 0;
  for (const m of html.matchAll(RE)) {
    const start = Math.max(0, m.index - 1500);
    const win = html.slice(start, m.index + 3000);
    const links = [...win.matchAll(/\/film\/(\d+)/g)];
    if (!links.length) continue;
    const rel = m.index - start;
    links.sort((a, b) => {
      const da = a.index >= rel ? a.index - rel : (rel - a.index) * 2;
      const db = b.index >= rel ? b.index - rel : (rel - b.index) * 2;
      return da - db;
    });
    const presale = /[öÖo]n\s*sat[ıi]ş/i.test(win);
    return { filmUrl: `${BASE}/film/${links[0][1]}`, presale, index: m.index };
  }
  return null;
}

// Film sayfasından poster URL'sini bul
async function findPoster(filmUrl, html, matchIndex) {
  const pick = (src) => {
    const og =
      src.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      src.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (og) return og[1];
    const img = src.match(/https?:\/\/[^"'\s)]+\/Uploads\/Films\/[^"'\s)]+\.(?:jpe?g|png|webp)/i);
    return img ? img[0] : null;
  };
  try {
    if (filmUrl) {
      const res = await fetch(filmUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const p = pick(await res.text());
      if (p) return p;
    }
  } catch {}
  return pick(html.slice(Math.max(0, matchIndex - 1500), matchIndex + 3000));
}

async function alarm(msg, poster, filmUrl) {
  const startId = await lastUpdateId();
  await notify(msg, poster);
  await sendText('Gördüysen bana herhangi bir şey yaz (örneğin "tamam"), hatırlatmaları durdurayım.');
  const title = `${FILM_NAME} SİTEDE!`;
  const body = 'Telegram\'daki mesaja bak. Durdurmak için bota "tamam" yaz.';
  await urgent(title, body, filmUrl, poster);

  const started = Date.now();
  let count = 1;
  while (Date.now() - started < REMIND_MAX) {
    await sleep(REMIND_EVERY);
    const who = await userReplied(startId);
    if (who) {
      await sendText(`${who} gördü, hatırlatmaları durdurdum. Bol şans!`);
      console.log(now(), "Kullanıcı gördü, durduruldu.");
      return;
    }
    count++;
    await sendText(`HATIRLATMA ${count}: ${FILM_NAME} sitede!\n${filmUrl}`);
    await urgent(`HATIRLATMA ${count}: ${title}`, body, filmUrl);
    console.log(now(), `Hatırlatma ${count} gönderildi`);
  }
  console.log(now(), "2 saat doldu, hatırlatmalar durdu.");
}

console.log(`${FILM_NAME} takip ediliyor... (yaklaşık dakikada bir kontrol)`);

while (true) {
  try {
    for (const page of PAGES) {
      const res = await fetch(page.url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await res.text();
      RE.lastIndex = 0;
      if (!RE.test(html)) continue;

      const film = findFilm(html);
      const filmUrl = film?.filmUrl ?? page.url;
      const poster = await findPoster(film?.filmUrl, html, film?.index ?? 0);
      const durum = film?.presale ? "ÖN SATIŞ AÇIK" : "Sitede göründü (ön satış etiketi bulunamadı, kontrol et)";
      const msg = [
        `${FILM_NAME} SİTEDE!`,
        "",
        `Durum: ${durum}`,
        `Bulunduğu yer: ${page.name}`,
        `Saat: ${now()}`,
        "",
        `Film ve seanslar: ${filmUrl}`,
      ].join("\n");

      console.log("Bulundu:\n" + msg + (poster ? `\nPoster: ${poster}` : "\n(poster bulunamadı)"));
      writeFileSync("FOUND", `${new Date().toISOString()}\n${filmUrl}\n`); // tekrar alarm verilmesin
      await alarm(msg, poster, filmUrl);
      process.exit(0);
    }
    console.log(now(), "henüz yok");
    if (MAX_RUNTIME_MIN && Date.now() - STARTED_AT > MAX_RUNTIME_MIN * 60000) {
      console.log(now(), `Süre doldu (${MAX_RUNTIME_MIN} dk), sonraki çalışma devralacak.`);
      process.exit(0);
    }
  } catch (e) {
    console.error(now(), "hata:", e.message);
  }
  await sleep(MIN_WAIT + Math.random() * (MAX_WAIT - MIN_WAIT));
}
