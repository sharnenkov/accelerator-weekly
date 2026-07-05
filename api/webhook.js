import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = 'sharnenkov/accelerator-weekly';
const DATA_FILE      = 'data.json';

// Allowed Telegram user IDs (set in env as comma-separated list, or leave empty = anyone)
const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Telegram helpers ──────────────────────────────────────────────────────────

function mdToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

async function tgSend(chatId, text, opts = {}) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: mdToHtml(text), parse_mode: 'HTML', ...opts }),
  });
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getDataJson() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  const meta = await res.json();
  const content = Buffer.from(meta.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: meta.sha };
}

async function putDataJson(data, sha, commitMsg) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMsg, content, sha }),
    }
  );
  return res.ok;
}

// ── State helpers (stored in GitHub state.json) ────────────────────────────────

const STATE_FILE = 'state.json';

async function getState() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) return { conversations: {}, sha: null };
    const meta = await res.json();
    const content = Buffer.from(meta.content, 'base64').toString('utf8');
    return { conversations: JSON.parse(content), sha: meta.sha };
  } catch { return { conversations: {}, sha: null }; }
}

async function saveState(conversations, sha) {
  const content = Buffer.from(JSON.stringify(conversations, null, 2)).toString('base64');
  const body = { message: 'chore: update bot state', content };
  if (sha) body.sha = sha;
  await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${STATE_FILE}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

// ── Claude prompt ─────────────────────────────────────────────────────────────

function systemPrompt(data) {
  const pilots = [
    ...data.pilots.active.map(p => `[активный] ${p.id} · ${p.name} (${p.stage})`),
    ...data.pilots.control.map(p => `[контроль] ${p.id} · ${p.name} (${p.stage})`),
  ].join('\n');

  return `Ты — ИИ-помощник команды Акселератора инноваций ЦИР. Помогаешь обновлять еженедельный дашборд через Telegram.

ВАЖНО — форматирование сообщений:
- Сообщения рендерятся в Telegram с parse_mode HTML
- Используй HTML-теги: <b>жирный</b>, <i>курсив</i>, <code>код</code>
- НЕ используй Markdown: никаких **звёздочек**, *курсива со звёздочками*, никаких обратных кавычек для выделения
- Используй эмодзи для визуальной структуры (📋 🔍 ✅ ❓ 📌 и т.д.)
- Пиши кратко и по делу, без лишних объяснений

Текущие данные дашборда (неделя ${data.meta.week}):

ПОИСК: ${data.search.innovations_week} инноваций на неделе, ${data.search.innovations_base} в базе
КОНВЕЙЕР (${data.pilots.active.length + data.pilots.control.length} пилотов):
${pilots}

Разделы: search (Поиск), pilots (Конвейер), infra (Инфраструктура), vnd (ВНД), pr (PR/Продвижение)

Твоя задача:
1. Понять, что именно хочет обновить пользователь
2. Если неясно — уточни (в каком разделе? по какому пилоту?)
3. Если всё ясно — верни JSON-патч для обновления data.json и краткое подтверждение
4. Обязательно уточни: есть ли артефакт (документ, ссылка, файл) к этому действию? Если пользователь сказал «/skip» — пропусти вопрос про артефакт.

Формат ответа когда всё ясно и подтверждено (СТРОГО):
PATCH:
\`\`\`json
{ ... patch object ... }
\`\`\`
CONFIRM: <краткое подтверждение на русском что именно обновлено>

Если нужно уточнить — просто задай вопрос на русском, без PATCH.

Patch-объект должен точно описывать изменения в data.json. Примеры:
- Обновить "done" пилота: { "pilots": { "active": { "find": "АИ.П26.01", "update": { "done": "...", "artifact": "..." } } } }
- Обновить инфра: { "infra": { "done": ["...", "..."], "artifacts": ["..."] } }
- Обновить PR: { "pr": { "community_total": 105 } }
- Обновить раздел поиска: { "search": { "innovations_week": 6 } }
- ВНД без данных: { "vnd": { "no_data": true, "no_data_reason": "..." } }`;
}

// ── Apply patch to data ────────────────────────────────────────────────────────

function applyPatch(data, patch) {
  const d = JSON.parse(JSON.stringify(data)); // deep clone

  for (const [key, val] of Object.entries(patch)) {
    if (key === 'pilots' && typeof val === 'object') {
      for (const [listKey, listPatch] of Object.entries(val)) {
        if (listPatch.find && listPatch.update) {
          const list = d.pilots[listKey];
          const idx = list.findIndex(p => p.id === listPatch.find || p.name.includes(listPatch.find));
          if (idx >= 0) Object.assign(list[idx], listPatch.update);
        }
      }
    } else if (typeof val === 'object' && !Array.isArray(val) && val !== null && typeof d[key] === 'object') {
      Object.assign(d[key], val);
    } else {
      d[key] = val;
    }
  }

  d.meta.updated = new Date().toISOString();
  return d;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const msg = update?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || '');
  const text = msg.text || '';

  // Auth check
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await tgSend(chatId, '⛔ Нет доступа.');
    return res.status(200).json({ ok: true });
  }

  // Load state + data in parallel
  const [stateResult, dataResult] = await Promise.all([getState(), getDataJson()]);
  const { conversations, sha: stateSha } = stateResult;
  const { data, sha: dataSha } = dataResult;

  if (!conversations[userId]) conversations[userId] = { messages: [] };
  const conv = conversations[userId];

  // Add user message to history
  conv.messages.push({ role: 'user', content: text });

  // Keep last 10 messages to avoid bloat
  if (conv.messages.length > 10) conv.messages = conv.messages.slice(-10);

  // Call Claude
  let claudeReply = '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt(data),
      messages: conv.messages,
    });
    claudeReply = response.content[0].text;
  } catch (err) {
    await tgSend(chatId, `❌ Ошибка Claude: ${err.message}`);
    return res.status(200).json({ ok: true });
  }

  // Add assistant reply to history
  conv.messages.push({ role: 'assistant', content: claudeReply });

  // Check if Claude returned a patch
  const patchMatch = claudeReply.match(/PATCH:\s*```json\s*([\s\S]+?)```/);
  const confirmMatch = claudeReply.match(/CONFIRM:\s*(.+)/);

  if (patchMatch) {
    try {
      const patch = JSON.parse(patchMatch[1]);
      const newData = applyPatch(data, patch);
      const ok = await putDataJson(newData, dataSha, `feat: update via bot — ${confirmMatch?.[1] || 'manual update'}`);

      if (ok) {
        conv.messages = []; // reset conversation after successful update
        await tgSend(chatId, `✅ ${confirmMatch?.[1] || 'Дашборд обновлён'}\n\n🔗 <a href="https://accelerator-weekly.vercel.app">Открыть дашборд</a>`);
      } else {
        await tgSend(chatId, '❌ Не удалось сохранить в GitHub. Попробуй ещё раз.');
      }
    } catch (err) {
      await tgSend(chatId, `❌ Ошибка при применении изменений: ${err.message}`);
    }
  } else {
    // Claude asks a clarifying question
    await tgSend(chatId, claudeReply);
  }

  // Save updated state
  await saveState(conversations, stateSha);

  return res.status(200).json({ ok: true });
}
