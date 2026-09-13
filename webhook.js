const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 10000);
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const PUBLIC_URL = (process.env.WEBHOOK_URL || 'https://test01uzbot-file-utility.onrender.com').replace(/\/$/, '');
const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ROOT_TMP = path.join(os.tmpdir(), 'test01uzbot');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const hookId = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 24);
const WEBHOOK_PATH = `/telegram/${hookId}`;
const WEBHOOK_FULL_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const sessions = new Map();
const stats = {
  startedAt: new Date(),
  users: new Set(),
  completed: 0,
  errors: 0,
  webhookUpdates: 0,
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
  return String(name)
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

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function downloadFile(ctx, meta, dir, index = 0) {
  if (meta.size && meta.size > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');
  const ext = path.extname(meta.name) || mimeExt(meta.mime);
  const local = path.join(dir, `${String(index).padStart(2, '0')}_${Date.now()}${ext}`);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const link = await ctx.telegram.getFileLink(meta.fileId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(link.href, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`DOWNLOAD_${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');
      await fsp.writeFile(local, buf);
      return { ...meta, local, size: meta.size || buf.length };
    } catch (err) {
      lastError = err;
      if (String(err?.message) === 'FILE_TOO_LARGE') throw err;
      console.error(`download attempt ${attempt}/3: ${cleanError(err)}`);
      if (attempt < 3) await sleep(700 * attempt);
    }
  }
  throw lastError || new Error('DOWNLOAD_FAILED');
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

async function imagesToPdf(files, output) {
  const pdf = await PDFDocument.create();
  for (const file of files) {
    const bytes = await fsp.readFile(file.local);
    const isPng = file.mime === 'image/png' || /\.png$/i.test(file.name);
    let img;
    try {
      img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    } catch {
      img = isPng ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    }
    const maxW = 595.28;
    const maxH = 841.89;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = Math.max(img.width * scale, 50);
    const h = Math.max(img.height * scale, 50);
    const page = pdf.addPage([w, h]);
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
    '• 🖼 <b>Rasm → PDF</b>: 1–10 ta JPG/PNG rasm yuboring, keyin /done.\n' +
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
bot.command('status', async (ctx) => {
  await ctx.reply('✅ Bot ishlayapti. Webhook faol.');
});
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
    await ctx.reply('❌ Faylni qayta ishlashda xato yuz berdi. Qayta urinib ko‘ring.');
  }
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendHelp(ctx);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await resetSession(userId(ctx));
  await sendMenu(ctx, '✅ Amal bekor qilindi.');
});

bot.action(/^mode:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const mode = ctx.match[1];
  const allowed = new Set(['image_pdf', 'merge_pdf', 'zip', 'rename', 'info']);
  if (!allowed.has(mode)) return ctx.reply('Noma’lum amal. /start bosing.');
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
  await ctx.reply(prompts[mode]);
});

bot.command('stats', async (ctx) => {
  if (!ADMIN_ID || userId(ctx) !== ADMIN_ID) return;
  const uptimeSec = Math.floor((Date.now() - stats.startedAt.getTime()) / 1000);
  await ctx.reply(
    `📊 Bot statistikasi\n\n` +
    `Foydalanuvchilar: ${stats.users.size}\n` +
    `Webhook update: ${stats.webhookUpdates}\n` +
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
    if (String(err?.message) === 'FILE_TOO_LARGE') return ctx.reply(`❌ Fayl juda katta. Limit: ${sizeText(MAX_FILE_SIZE)}.`);
    return ctx.reply('❌ Faylni yuklab olishda xato bo‘ldi. Qayta urinib ko‘ring.');
  }
});

bot.on('text', async (ctx, next) => {
  const id = userId(ctx);
  const s = sessions.get(id);
  if (!s || s.mode !== 'rename' || !s.waitingName || !s.files[0]) return next();
  if (ctx.message.text.startsWith('/')) return next();

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

bot.catch(async (err, ctx) => {
  stats.errors += 1;
  console.error(`bot error: ${cleanError(err)}`);
  if (ctx?.chat?.id) await ctx.reply('⚠️ Kutilmagan xato yuz berdi. /start bilan qayta urinib ko‘ring.').catch(() => {});
});

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.status(200).send('Test01 Utility Bot is running in webhook mode'));
app.get('/health', async (_req, res) => {
  let webhook = null;
  try {
    const info = await bot.telegram.getWebhookInfo();
    webhook = {
      active: info.url === WEBHOOK_FULL_URL,
      pending: info.pending_update_count || 0,
      lastError: info.last_error_message || null
    };
  } catch (err) {
    webhook = { active: false, error: cleanError(err) };
  }
  res.status(200).json({ ok: true, bot: '@Test01uzbot', mode: 'webhook', activeSessions: sessions.size, webhook });
});

app.post(WEBHOOK_PATH, (req, res) => {
  res.sendStatus(200);
  stats.webhookUpdates += 1;
  bot.handleUpdate(req.body).catch((err) => {
    stats.errors += 1;
    console.error(`webhook update error: ${cleanError(err)}`);
  });
});

async function listen(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  await ensureTmp();
  bot.botInfo = await bot.telegram.getMe();
  const server = await listen(PORT);
  console.log(`HTTP server listening on ${PORT}`);

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Botni ishga tushirish' },
    { command: 'help', description: 'Yordam' },
    { command: 'status', description: 'Bot holatini tekshirish' },
    { command: 'done', description: 'Fayllarni qayta ishlashni boshlash' },
    { command: 'cancel', description: 'Amalni bekor qilish' }
  ]);

  await bot.telegram.callApi('setWebhook', {
    url: WEBHOOK_FULL_URL,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 20,
    drop_pending_updates: false
  });

  const info = await bot.telegram.getWebhookInfo();
  if (info.url !== WEBHOOK_FULL_URL) throw new Error('WEBHOOK_NOT_REGISTERED');
  console.log(`@${bot.botInfo.username} webhook active; pending=${info.pending_update_count || 0}`);

  const shutdown = async (signal) => {
    console.log(`${signal} received`);
    for (const id of sessions.keys()) await resetSession(id);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
})().catch((err) => {
  console.error(`startup error: ${cleanError(err)}`);
  process.exit(1);
});
