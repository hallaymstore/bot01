const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 10000);
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ROOT_TMP = path.join(os.tmpdir(), 'test01uzbot');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const sessions = new Map();
const stats = {
  startedAt: new Date(),
  users: new Set(),
  completed: 0,
  errors: 0,
  byType: { image_pdf: 0, merge_pdf: 0, zip: 0, rename: 0, info: 0 }
};

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🖼 Rasm → PDF', 'mode:image_pdf'), Markup.button.callback('📚 PDF birlashtirish', 'mode:merge_pdf')],
  [Markup.button.callback('🗜 ZIP yaratish', 'mode:zip'), Markup.button.callback('✏️ Nomini o‘zgartirish', 'mode:rename')],
  [Markup.button.callback('ℹ️ Fayl ma’lumoti', 'mode:info'), Markup.button.callback('❌ Bekor qilish', 'cancel')],
  [Markup.button.callback('❓ Yordam', 'help')]
]);

function userId(ctx) {
  return ctx.from?.id;
}

function safeName(name = 'file') {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'file';
}

function sizeText(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(err) {
  return String(err?.message || err || 'UNKNOWN').replaceAll(BOT_TOKEN, '[REDACTED]');
}

async function cleanDir(dir) {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function resetSession(id) {
  const old = sessions.get(id);
  if (old?.dir) await cleanDir(old.dir);
  sessions.delete(id);
}

async function makeSession(id, mode) {
  await resetSession(id);
  const dir = await fsp.mkdtemp(path.join(ROOT_TMP, `${id}-`));
  const session = { mode, dir, files: [], waitingName: false };
  sessions.set(id, session);
  return session;
}

async function ensureTmp() {
  await fsp.mkdir(ROOT_TMP, { recursive: true });
}

function fileMetaFromMessage(msg) {
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      uniqueId: msg.document.file_unique_id,
      name: safeName(msg.document.file_name || 'document'),
      mime: msg.document.mime_type || 'application/octet-stream',
      size: msg.document.file_size || 0,
      kind: 'document'
    };
  }
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return {
      fileId: p.file_id,
      uniqueId: p.file_unique_id,
      name: `photo_${Date.now()}.jpg`,
      mime: 'image/jpeg',
      size: p.file_size || 0,
      kind: 'photo'
    };
  }
  return null;
}

async function downloadFile(ctx, meta, dir, index = 0) {
  if (meta.size && meta.size > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');
  const link = await ctx.telegram.getFileLink(meta.fileId);
  const ext = path.extname(meta.name) || mimeExt(meta.mime);
  const local = path.join(dir, `${String(index).padStart(2, '0')}_${Date.now()}${ext}`);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`DOWNLOAD_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');
  await fsp.writeFile(local, buf);
  return { ...meta, local, size: meta.size || buf.length };
}

async function sendDocumentRobust(ctx, filePath, filename, caption = '✅ Tayyor!') {
  const data = await fsp.readFile(filePath);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const form = new FormData();
      form.append('chat_id', String(ctx.chat.id));
      form.append('caption', caption);
      form.append('document', new Blob([data]), filename);

      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      clearTimeout(timer);

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(`SEND_DOCUMENT_${response.status}_${result?.description || 'UNKNOWN'}`);
      }
      return result.result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      console.error(`sendDocument attempt ${attempt}/3: ${cleanError(err)}`);
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }

  throw lastError || new Error('SEND_DOCUMENT_FAILED');
}

function mimeExt(mime = '') {
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('text')) return '.txt';
  return '';
}

function isImage(meta) {
  return meta.kind === 'photo' || meta.mime === 'image/jpeg' || meta.mime === 'image/png' || /\.(jpe?g|png)$/i.test(meta.name);
}

function isPdf(meta) {
  return meta.mime === 'application/pdf' || /\.pdf$/i.test(meta.name);
}

async function imagesToPdf(files, output) {
  const pdf = await PDFDocument.create();
  for (const file of files) {
    const bytes = await fsp.readFile(file.local);
    const img = file.mime === 'image/png' || /\.png$/i.test(file.name)
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);
    const maxW = 595.28;
    const maxH = 841.89;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = pdf.addPage([Math.max(w, 50), Math.max(h, 50)]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  await fsp.writeFile(output, await pdf.save());
}

async function mergePdfs(files, output) {
  const out = await PDFDocument.create();
  for (const file of files) {
    const src = await PDFDocument.load(await fsp.readFile(file.local), { ignoreEncryption: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
  }
  await fsp.writeFile(output, await out.save());
}

async function zipFiles(files, output) {
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(output);
    const archive = archiver('zip', { zlib: { level: 9 } });
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    const used = new Map();
    files.forEach((file, i) => {
      let name = safeName(file.name || `file_${i + 1}`);
      const count = used.get(name) || 0;
      used.set(name, count + 1);
      if (count) {
        const ext = path.extname(name);
        name = `${path.basename(name, ext)}_${count + 1}${ext}`;
      }
      archive.file(file.local, { name });
    });
    archive.finalize();
  });
}

async function sendMenu(ctx, text = 'Kerakli amalni tanlang 👇') {
  return ctx.reply(text, mainKeyboard);
}

async function sendHelp(ctx) {
  return ctx.reply(
    '🧰 <b>Test01 Utility Bot</b>\n\n' +
    '• 🖼 <b>Rasm → PDF</b>: 1–10 ta JPG/PNG yuboring, keyin /done.\n' +
    '• 📚 <b>PDF birlashtirish</b>: 2–10 ta PDF yuboring, keyin /done.\n' +
    '• 🗜 <b>ZIP yaratish</b>: 1–10 ta fayl yuboring, keyin /done.\n' +
    '• ✏️ <b>Nomini o‘zgartirish</b>: bitta fayl yuboring, keyin yangi nom yozing.\n' +
    '• ℹ️ <b>Fayl ma’lumoti</b>: fayl yuboring.\n\n' +
    `Bir fayl uchun limit: <b>${sizeText(MAX_FILE_SIZE)}</b>.\n` +
    'Bekor qilish: /cancel',
    { parse_mode: 'HTML', ...mainKeyboard }
  );
}

bot.start(async (ctx) => {
  stats.users.add(userId(ctx));
  await sendMenu(ctx, `Salom, ${ctx.from?.first_name || 'foydalanuvchi'}! 👋\n\nMen fayllar bilan tez ishlashga yordam beraman.`);
});

bot.command('help', sendHelp);
bot.command('cancel', async (ctx) => {
  await resetSession(userId(ctx));
  await sendMenu(ctx, '✅ Amal bekor qilindi.');
});

bot.command('done', async (ctx) => {
  const id = userId(ctx);
  const s = sessions.get(id);
  if (!s || !['image_pdf', 'merge_pdf', 'zip'].includes(s.mode)) {
    return ctx.reply('Hozir yakunlanadigan amal yo‘q. Menyudan amal tanlang.');
  }
  if (!s.files.length) return ctx.reply('Avval fayl yuboring.');
  if (s.mode === 'merge_pdf' && s.files.length < 2) return ctx.reply('PDF birlashtirish uchun kamida 2 ta PDF kerak.');

  const wait = await ctx.reply('⏳ Tayyorlayapman...');
  try {
    let output;
    let filename;
    if (s.mode === 'image_pdf') {
      output = path.join(s.dir, 'rasmlar.pdf');
      await imagesToPdf(s.files, output);
      filename = 'rasmlar.pdf';
    } else if (s.mode === 'merge_pdf') {
      output = path.join(s.dir, 'birlashtirilgan.pdf');
      await mergePdfs(s.files, output);
      filename = 'birlashtirilgan.pdf';
    } else {
      output = path.join(s.dir, 'fayllar.zip');
      await zipFiles(s.files, output);
      filename = 'fayllar.zip';
    }

    await sendDocumentRobust(ctx, output, filename, '✅ Tayyor!');
    stats.completed += 1;
    stats.byType[s.mode] += 1;
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    await resetSession(id);
    await sendMenu(ctx);
  } catch (err) {
    stats.errors += 1;
    const msg = cleanError(err);
    console.error(`done error: ${msg}`);
    if (msg.includes('SEND_DOCUMENT') || msg.includes('fetch failed') || msg.includes('abort')) {
      return ctx.reply('⚠️ Fayl tayyor bo‘ldi, lekin Telegramga yuborishda tarmoq uzildi. /done ni yana bir marta bosing.');
    }
    await ctx.reply('❌ Faylni qayta ishlashda xato yuz berdi. Fayl buzilgan yoki qo‘llab-quvvatlanmaydigan formatda bo‘lishi mumkin.');
  }
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await sendHelp(ctx);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await resetSession(userId(ctx));
  await sendMenu(ctx, '✅ Amal bekor qilindi.');
});

bot.action(/^mode:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const mode = ctx.match[1];
  const id = userId(ctx);
  stats.users.add(id);
  await makeSession(id, mode);
  const prompts = {
    image_pdf: '🖼 1–10 ta JPG/PNG rasm yuboring. Hammasini yuborgach /done bosing.',
    merge_pdf: '📚 2–10 ta PDF fayl yuboring. Tartib yuborilgan ketma-ketlik bo‘yicha bo‘ladi. Keyin /done bosing.',
    zip: '🗜 ZIP ichiga qo‘shmoqchi bo‘lgan 1–10 ta faylni yuboring. Keyin /done bosing.',
    rename: '✏️ Nomini o‘zgartirmoqchi bo‘lgan bitta faylni yuboring.',
    info: 'ℹ️ Ma’lumotini ko‘rmoqchi bo‘lgan faylni yuboring.'
  };
  await ctx.reply(prompts[mode] || 'Fayl yuboring.');
});

bot.command('stats', async (ctx) => {
  if (!ADMIN_ID || userId(ctx) !== ADMIN_ID) return;
  const uptimeSec = Math.floor((Date.now() - stats.startedAt.getTime()) / 1000);
  await ctx.reply(
    `📊 Bot statistikasi\n\n` +
    `Foydalanuvchilar: ${stats.users.size}\n` +
    `Tayyor operatsiyalar: ${stats.completed}\n` +
    `Xatolar: ${stats.errors}\n` +
    `Aktiv sessiyalar: ${sessions.size}\n` +
    `Rasm→PDF: ${stats.byType.image_pdf}\n` +
    `PDF merge: ${stats.byType.merge_pdf}\n` +
    `ZIP: ${stats.byType.zip}\n` +
    `Rename: ${stats.byType.rename}\n` +
    `Info: ${stats.byType.info}\n` +
    `Uptime: ${uptimeSec}s`
  );
});

bot.on(['document', 'photo'], async (ctx) => {
  const id = userId(ctx);
  stats.users.add(id);
  const s = sessions.get(id);
  if (!s) return sendMenu(ctx, 'Avval qanday amal qilishni tanlang 👇');

  const meta = fileMetaFromMessage(ctx.message);
  if (!meta) return ctx.reply('Bu fayl turi qo‘llab-quvvatlanmadi.');
  if (meta.size && meta.size > MAX_FILE_SIZE) return ctx.reply(`❌ Fayl juda katta. Limit: ${sizeText(MAX_FILE_SIZE)}.`);

  try {
    if (s.mode === 'info') {
      stats.completed += 1;
      stats.byType.info += 1;
      await ctx.reply(
        `ℹ️ <b>Fayl ma’lumoti</b>\n\n` +
        `Nomi: <code>${escapeHtml(meta.name)}</code>\n` +
        `Turi: <code>${escapeHtml(meta.mime)}</code>\n` +
        `Hajmi: <b>${sizeText(meta.size)}</b>\n` +
        `Telegram ID: <code>${escapeHtml(meta.uniqueId)}</code>`,
        { parse_mode: 'HTML' }
      );
      await resetSession(id);
      return sendMenu(ctx);
    }

    if (s.files.length >= MAX_FILES) return ctx.reply(`❌ Maksimum ${MAX_FILES} ta fayl.`);
    if (s.mode === 'image_pdf' && !isImage(meta)) return ctx.reply('Faqat JPG yoki PNG rasm yuboring.');
    if (s.mode === 'merge_pdf' && !isPdf(meta)) return ctx.reply('Faqat PDF fayl yuboring.');

    const downloaded = await downloadFile(ctx, meta, s.dir, s.files.length + 1);
    s.files.push(downloaded);

    if (s.mode === 'rename') {
      s.waitingName = true;
      return ctx.reply(`✅ Fayl olindi: ${meta.name}\n\nYangi nomini yozing. Masalan: <code>hisobot.pdf</code>`, { parse_mode: 'HTML' });
    }

    await ctx.reply(`✅ Qabul qilindi (${s.files.length}/${MAX_FILES}): ${meta.name}\nYana yuboring yoki /done bosing.`);
  } catch (err) {
    stats.errors += 1;
    console.error(`file error: ${cleanError(err)}`);
    if (String(err.message) === 'FILE_TOO_LARGE') return ctx.reply(`❌ Fayl juda katta. Limit: ${sizeText(MAX_FILE_SIZE)}.`);
    return ctx.reply('❌ Faylni yuklab olishda xato bo‘ldi. Qayta urinib ko‘ring.');
  }
});

bot.on('text', async (ctx, next) => {
  const id = userId(ctx);
  const s = sessions.get(id);
  if (!s || s.mode !== 'rename' || !s.waitingName || !s.files[0]) return next();

  const old = s.files[0];
  let newName = safeName(ctx.message.text);
  if (!path.extname(newName)) newName += path.extname(old.name);
  if (newName.length < 2) return ctx.reply('Yangi nom juda qisqa. Boshqa nom yozing.');

  try {
    const target = path.join(s.dir, newName);
    await fsp.copyFile(old.local, target);
    await sendDocumentRobust(ctx, target, newName, `✅ Yangi nom: ${newName}`);
    stats.completed += 1;
    stats.byType.rename += 1;
    await resetSession(id);
    await sendMenu(ctx);
  } catch (err) {
    stats.errors += 1;
    console.error(`rename error: ${cleanError(err)}`);
    await ctx.reply('❌ Fayl nomini o‘zgartirishda yoki yuborishda xato bo‘ldi. Qayta urinib ko‘ring.');
  }
});

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

bot.catch(async (err, ctx) => {
  stats.errors += 1;
  console.error(`bot error: ${cleanError(err)}`);
  if (ctx?.chat?.id) await ctx.reply('⚠️ Kutilmagan xato yuz berdi. /start bilan qayta urinib ko‘ring.').catch(() => {});
});

app.get('/', (_req, res) => res.status(200).send('Test01 Utility Bot is running'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, bot: '@Test01uzbot', activeSessions: sessions.size }));

(async () => {
  await ensureTmp();
  app.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}`));
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Botni ishga tushirish' },
    { command: 'help', description: 'Yordam' },
    { command: 'done', description: 'Fayllarni qayta ishlashni boshlash' },
    { command: 'cancel', description: 'Amalni bekor qilish' }
  ]).catch((err) => console.error(`setMyCommands error: ${cleanError(err)}`));
  bot.launch({ dropPendingUpdates: true });
  console.log('@Test01uzbot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
