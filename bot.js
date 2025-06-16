require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const axios = require('axios');

// Fungsi untuk escape karakter Markdown (MarkdownV1)
function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/`/g, '\\`')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

if (!process.env.BOT_TOKEN) {
  console.error('Error: BOT_TOKEN belum diatur di file .env');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const sessions = {};

const menus = `📋 *Menu Utama*:

🚀 /deploy        → Upload Worker dari GitHub  
📂 /buat_kv       → Membuat penyimpanan KV  
🔗 /binding       → Hubungkan KV ke Worker  
🧾 /list_worker   → Lihat semua Worker  
🗃️ /list_kv       → Lihat semua KV  
🔐 /logout        → Keluar dari akun Cloudflare`;

// Start/Menu
bot.onText(/\/(start|menu)/, (msg) => {
  const id = msg.from.id;
  bot.sendMessage(id, `👋 Selamat datang di *Bot Cloudflare Manager!*

Ketik /login untuk mulai.

${menus}`, { parse_mode: 'Markdown' });
});

// LOGIN multi-step
bot.onText(/\/login/, (msg) => {
  const id = msg.from.id;
  sessions[id] = { step: 1 };
  bot.sendMessage(id, '🔑 Langkah 1/3 – Masukkan *API Token* kamu:', { parse_mode: 'Markdown' });
});

// Handle message step by step
bot.on('message', async (msg) => {
  const id = msg.from.id;
  if (!msg.text) return; // Hanya proses pesan text
  const data = msg.text;
  if (!sessions[id] || data.startsWith('/')) return; // Hanya kalau sedang di sesi/step

  const session = sessions[id];

  try {
    if (session.step === 1) {
      session.cf_token = data.trim();
      session.step = 2;
      bot.sendMessage(id, '🧾 Langkah 2/3 – Masukkan *Account ID* kamu:', { parse_mode: 'Markdown' });

    } else if (session.step === 2) {
      session.cf_account_id = data.trim();
      session.step = 3;
      bot.sendMessage(id, '🌐 Langkah 3/3 – Masukkan *Zone ID* (boleh ketik "lewati"):', { parse_mode: 'Markdown' });

    } else if (session.step === 3) {
      session.cf_zone_id = data.toLowerCase() === 'lewati' ? null : data.trim();
      session.step = null;
      bot.sendMessage(id, `✅ Login berhasil!\n\n${menus}`, { parse_mode: 'Markdown' });

    } else if (session.step === 'deploy_git') {
      session.repo_url = data.trim();
      session.step = 'deploy_name';
      bot.sendMessage(id, '📛 Masukkan nama Worker:');

    } else if (session.step === 'deploy_name') {
      const name = data.trim();
      const repo = session.repo_url;
      const { cf_token, cf_account_id } = session;

      if (!repo || !name || !cf_token || !cf_account_id) {
        bot.sendMessage(id, '❌ Data tidak lengkap. Pastikan sudah login dan input benar.');
        session.step = null;
        return;
      }

      const folder = `/tmp/worker-${id}`;
      const cmd = `rm -rf ${folder} && git clone ${repo} ${folder} && cd ${folder} && npx wrangler publish --name ${name} --account-id ${cf_account_id} --api-token ${cf_token}`;

      bot.sendMessage(id, '🚧 Sedang deploy Worker...');
      exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err) {
          bot.sendMessage(id, `❌ Gagal deploy:\n${escapeMarkdown(stderr || err.message)}`, { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(id, `✅ Worker *${escapeMarkdown(name)}* berhasil dideploy.`, { parse_mode: 'Markdown' });
        }
      });
      session.step = null;

    } else if (session.step === 'buat_kv') {
      const kvName = data.trim();
      const { cf_token, cf_account_id } = session;
      if (!kvName) {
        bot.sendMessage(id, '❌ Nama KV tidak boleh kosong.');
        session.step = null;
        return;
      }
      try {
        await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${cf_account_id}/storage/kv/namespaces`,
          { title: kvName },
          { headers: { Authorization: `Bearer ${cf_token}` } }
        );
        bot.sendMessage(id, `✅ KV Namespace *${escapeMarkdown(kvName)}* berhasil dibuat!`, { parse_mode: 'Markdown' });
      } catch (err) {
        bot.sendMessage(id, `❌ Gagal membuat KV: ${escapeMarkdown(err.response?.data?.errors?.[0]?.message || err.message)}`, { parse_mode: 'Markdown' });
      }
      session.step = null;

    } else if (session.step === 'binding_name') {
      session.binding_name = data.trim();
      session.step = 'binding_namespace';
      bot.sendMessage(id, '🗂️ Masukkan ID Namespace KV yang ingin di-binding:');

    } else if (session.step === 'binding_namespace') {
      session.namespace_id = data.trim();
      session.step = 'binding_worker';
      bot.sendMessage(id, '🛠️ Masukkan nama Worker yang ingin di-binding:');

    } else if (session.step === 'binding_worker') {
      const { cf_token, cf_account_id, binding_name, namespace_id } = session;
      const worker_name = data.trim();
      try {
        await axios.put(
          `https://api.cloudflare.com/client/v4/accounts/${cf_account_id}/workers/services/${worker_name}/environments/production/bindings`,
          {
            bindings: [
              {
                name: binding_name,
                type: 'kv_namespace',
                namespace_id,
              },
            ],
          },
          {
            headers: { Authorization: `Bearer ${cf_token}` },
          }
        );
        bot.sendMessage(
          id,
          `✅ KV berhasil dibinding ke Worker *${escapeMarkdown(worker_name)}* dengan nama binding *${escapeMarkdown(binding_name)}*`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        bot.sendMessage(id, `❌ Gagal binding: ${escapeMarkdown(err.response?.data?.errors?.[0]?.message || err.message)}`, { parse_mode: 'Markdown' });
      }
      session.step = null;
    }
  } catch (err) {
    bot.sendMessage(id, `❌ Terjadi error: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
    session.step = null;
  }
});

// LOGOUT
bot.onText(/\/logout/, (msg) => {
  delete sessions[msg.from.id];
  bot.sendMessage(msg.chat.id, '✅ Kamu sudah logout.');
});

// DEPLOY
bot.onText(/\/deploy/, (msg) => {
  const id = msg.from.id;
  if (!sessions[id]?.cf_token) {
    bot.sendMessage(id, '❗ Kamu belum login.');
    return;
  }
  bot.sendMessage(id, '🔗 Kirim link GitHub (public) yang ingin kamu deploy:');
  sessions[id].step = 'deploy_git';
});

// BUAT KV
bot.onText(/\/buat_kv/, (msg) => {
  const id = msg.from.id;
  if (!sessions[id]?.cf_token) {
    bot.sendMessage(id, '❗ Kamu belum login.');
    return;
  }
  bot.sendMessage(id, '📂 Masukkan nama KV Namespace yang ingin dibuat:');
  sessions[id].step = 'buat_kv';
});

// BINDING
bot.onText(/\/binding/, (msg) => {
  const id = msg.from.id;
  if (!sessions[id]?.cf_token) {
    bot.sendMessage(id, '❗ Kamu belum login.');
    return;
  }
  bot.sendMessage(id, '🔗 Masukkan nama binding (nama KV di Worker):');
  sessions[id].step = 'binding_name';
});

// LIST WORKER
bot.onText(/\/list_worker/, async (msg) => {
  const id = msg.from.id;
  const { cf_token, cf_account_id } = sessions[id] || {};
  if (!cf_token) {
    bot.sendMessage(id, '❗ Kamu belum login.');
    return;
  }
  try {
    const res = await axios.get(
      `https://api.cloudflare.com/client/v4/accounts/${cf_account_id}/workers/services`,
      { headers: { Authorization: `Bearer ${cf_token}` } }
    );
    const list = res.data.result.map(w => `• ${escapeMarkdown(w.default_environment?.script)}`).join('\n') || 'Tidak ada Worker.';
    bot.sendMessage(id, `🧾 *Daftar Worker:*\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(id, '❌ Gagal mengambil daftar Worker.');
  }
});

// LIST KV
bot.onText(/\/list_kv/, async (msg) => {
  const id = msg.from.id;
  const { cf_token, cf_account_id } = sessions[id] || {};
  if (!cf_token) {
    bot.sendMessage(id, '❗ Kamu belum login.');
    return;
  }
  try {
    const res = await axios.get(
      `https://api.cloudflare.com/client/v4/accounts/${cf_account_id}/storage/kv/namespaces`,
      { headers: { Authorization: `Bearer ${cf_token}` } }
    );
    const list = res.data.result.map(kv => `• ${escapeMarkdown(kv.title)} (${escapeMarkdown(kv.id)})`).join('\n') || 'Tidak ada KV.';
    bot.sendMessage(id, `📂 *Daftar KV Namespace:*\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(id, '❌ Gagal mengambil daftar KV.');
  }
});
