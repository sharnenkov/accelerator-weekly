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
  // Only convert markdown — don't escape HTML tags Claude already wrote
  return text
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/\*(.+?)\*/gs, '<i>$1</i>')
    .replace(/__(.+?)__/gs, '<b>$1</b>')
    .replace(/_(.+?)_/gs, '<i>$1</i>')
    .replace(/`(.+?)`/gs, '<code>$1</code>');
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

function systemPrompt(data, firstName) {
  const pilots = [
    ...data.pilots.active.map(p => `[активный] ${p.id} · ${p.name} (${p.stage})`),
    ...data.pilots.control.map(p => `[контроль] ${p.id} · ${p.name} (${p.stage})`),
  ].join('\n');

  const userLine = firstName ? `Собеседник: ${firstName}. Обращайся по имени в ответах.` : '';
  return `Ты — Реактор, ИИ-помощник команды Акселератора инноваций ЦИР (Центр инноваций и развития).
Твой Telegram-username: @reacto_robot. Если спрашивают имя, username или собаку — отвечай именно это, без вариантов.
Работаешь в Telegram, помогаешь команде вести еженедельный дашборд и отвечаешь на вопросы по нему.
${userLine}

━━━ ФОРМАТИРОВАНИЕ ━━━
Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>, <code>код</code>
НЕ используй Markdown-звёздочки (**text**, *text*) — они не рендерятся.
Используй эмодзи для структуры. Пиши кратко и по делу.

━━━ ДАШБОРДЫ ━━━
Есть два дашборда, оба читают данные из GitHub в реальном времени:

📌 <b>Текущая неделя (WIP)</b>: https://accelerator-weekly-new.vercel.app
— Данные из data-new.json. Сюда вносятся обновления в течение недели через бота.
— Показывает только то, что уже внесено — пустые разделы скрыты.

📌 <b>Опубликованная неделя (факт)</b>: https://accelerator-weekly.vercel.app
— Данные из data.json. Финальный отчёт прошлой недели, не меняется.
— Каждый понедельник в 06:00 МСК данные из WIP автоматически становятся фактом.

━━━ КАК ФОРМИРОВАТЬ ДАШБОРД ━━━
Дашборд состоит из 5 разделов. По каждому нужно внести за неделю:

🔍 <b>Поиск</b> — сколько новых инноваций найдено + карточка по каждой:
  · название и описание решения
  · что сделано на встрече
  · артефакт (оценка интереса, анкета и т.д.)

⚙️ <b>Конвейер</b> — по каждому активному пилоту:
  · что сделано на неделе (встречи, решения, действия)
  · артефакт (документ, план-график, БТ, отчёт)
  Пилоты на контроле — только артефакт если есть изменение.

🏗️ <b>Инфра</b> — по инфраструктурному проекту:
  · список сделанного
  · список артефактов

📋 <b>ВНД</b> — методология и регламенты:
  · если обновлений нет — указать причину (отпуск, нет встреч и т.д.)
  · если есть — название документа, что сделано, артефакт

📣 <b>PR</b> — продвижение:
  · публикации внутренние и внешние (количество)
  · прирост сообщества ЦИР на Ньютоне и общее число
  · карточки активностей (что сделано, артефакт)
  · ОБЯЗАТЕЛЬНО спросить: «Что было ключевым фокусом прошедшей недели?»
  · ОБЯЗАТЕЛЬНО спросить: «Какое событие запланировано на следующую неделю и когда?»

💡 <b>Советы по заполнению:</b>
· Заполняй по ходу недели, не откладывай на пятницу — бот всегда под рукой
· «Что сделано» — конкретное действие (встреча, решение, отправка), не статус
· Артефакт — осязаемый результат: документ, ссылка, таблица, письмо
· Если артефакта нет — скажи «/skip», бот не будет переспрашивать
· Пилоты на контроле наследуют артефакты с прошлой недели автоматически

━━━ ТЕКУЩИЕ ДАННЫЕ (Н${data.meta.week}) ━━━
Поиск: ${data.search.innovations_week} инноваций на неделе, ${data.search.innovations_base} в базе
Конвейер: ${data.pilots.active.length} активных + ${data.pilots.control.length} на контроле

${pilots}

━━━ ОБНОВЛЕНИЕ ДАННЫХ ━━━
Важно: данные НАКАПЛИВАЮТСЯ, не перезаписываются.
· Поля "done" и "artifact" у пилотов — дописываются через " · "
· Массивы infra.done, infra.artifacts, search.items, pr.cards, vnd.items — пополняются
· Начинай новую запись с даты: "05.07 — текст"
· Разные люди могут вносить данные по одному пилоту в разные дни — всё сохранится

Когда пользователь хочет внести обновление:
1. Уточни если неясно — какой раздел, какой пилот
2. Спроси про артефакт (если не упомянул). /skip — пропустить.
3. Верни патч в строгом формате:

PATCH:
\`\`\`json
{ patch object }
\`\`\`
CONFIRM: <что обновлено>

Примеры патчей:
· Пилот активный: { "pilots": { "active": { "find": "АИ.П26.01", "update": { "done": "05.07 — Проведена встреча", "artifact": "Протокол встречи" } } } }
· Пилот контроль: { "pilots": { "control": { "find": "АИ.П26.02", "update": { "artifact": "Финальный отчёт" } } } }
· Инфра (добавить): { "infra": { "done": ["05.07 — Настроен доступ к LLM"], "artifacts": ["Инструкция по подключению"] } }
· PR: { "pr": { "community_total": 105 } }
· Поиск (счётчик): { "search": { "innovations_week": 6 } }
· Новая карточка поиска: { "search": { "items": [{ "id": "newid", "name": "...", "desc": "...", "done": "05.07 — ...", "artifact": "..." }] } }
· ВНД нет данных: { "vnd": { "no_data": true, "no_data_reason": "Отпуск: Иванов" } }`;
}

// ── Apply patch to data ────────────────────────────────────────────────────────

function appendStr(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return existing + ' · ' + incoming;
}

function applyPatch(data, patch) {
  const d = JSON.parse(JSON.stringify(data));

  for (const [key, val] of Object.entries(patch)) {

    if (key === 'pilots' && typeof val === 'object') {
      for (const [listKey, listPatch] of Object.entries(val)) {
        if (!listPatch.find || !listPatch.update) continue;
        const list = d.pilots[listKey];
        const idx = list.findIndex(p => p.id === listPatch.find || p.name.includes(listPatch.find));
        if (idx < 0) continue;
        const pilot = list[idx];
        for (const [field, newVal] of Object.entries(listPatch.update)) {
          // Accumulate text fields, replace everything else
          if ((field === 'done' || field === 'artifact') && typeof newVal === 'string') {
            pilot[field] = appendStr(pilot[field], newVal);
          } else {
            pilot[field] = newVal;
          }
        }
      }

    } else if (key === 'infra' && typeof val === 'object') {
      if (val.done)      d.infra.done      = [...(d.infra.done || []),      ...[].concat(val.done)];
      if (val.artifacts) d.infra.artifacts = [...(d.infra.artifacts || []), ...[].concat(val.artifacts)];
      for (const [f, v] of Object.entries(val)) {
        if (f !== 'done' && f !== 'artifacts') d.infra[f] = v;
      }

    } else if (key === 'search' && typeof val === 'object') {
      if (val.items) d.search.items = [...(d.search.items || []), ...[].concat(val.items)];
      for (const [f, v] of Object.entries(val)) {
        if (f !== 'items') d.search[f] = v;
      }

    } else if (key === 'pr' && typeof val === 'object') {
      if (val.cards) d.pr.cards = [...(d.pr.cards || []), ...[].concat(val.cards)];
      for (const [f, v] of Object.entries(val)) {
        if (f !== 'cards') d.pr[f] = v;
      }

    } else if (key === 'vnd' && typeof val === 'object') {
      if (val.items) d.vnd.items = [...(d.vnd.items || []), ...[].concat(val.items)];
      for (const [f, v] of Object.entries(val)) {
        if (f !== 'items') d.vnd[f] = v;
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

  // Respond to Telegram immediately so it doesn't retry while we process
  res.status(200).json({ ok: true });

  const updateId = String(update.update_id || '');
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || '');
  const text = msg.text || '';
  const firstName = msg.from?.first_name || '';
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const BOT_USERNAME = 'reacto_robot';
  const BOT_ID = 8957784340;

  // In groups respond only when: mentioned, reply to bot, or contains trigger word
  if (isGroup) {
    const mentionsBot = text.toLowerCase().includes(`@${BOT_USERNAME}`) || text.toLowerCase().includes('реактор');
    const replyToBot = msg.reply_to_message?.from?.id === BOT_ID;
    if (!mentionsBot && !replyToBot) return res.status(200).json({ ok: true });
  }

  // Strip @mention from text so Claude doesn't see it
  const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();

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
  conv.messages.push({ role: 'user', content: cleanText || text });

  // Keep last 10 messages to avoid bloat
  if (conv.messages.length > 10) conv.messages = conv.messages.slice(-10);

  // Call Claude
  let claudeReply = '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt(data, firstName),
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
