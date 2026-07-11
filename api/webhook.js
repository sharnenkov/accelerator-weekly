import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = 'sharnenkov/accelerator-weekly';
const DATA_FILE      = 'data-new.json';

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Telegram helpers ──────────────────────────────────────────────────────────

function mdToHtml(text) {
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

// ── Human-readable patch preview ──────────────────────────────────────────────

function previewPatch(patch, data) {
  const lines = [];

  if (patch.pilots) {
    for (const [listKey, listPatch] of Object.entries(patch.pilots)) {
      if (!listPatch.find || !listPatch.update) continue;
      const found = data.pilots[listKey]?.find(
        p => p.id === listPatch.find || p.name.includes(listPatch.find)
      );
      const label = listKey === 'active' ? 'активный' : 'контроль';
      const name = found ? `${found.id} · ${found.name}` : listPatch.find;
      lines.push(`🔹 <b>${name}</b> [${label}]${listPatch['$set'] ? ' <i>(замена)</i>' : ''}`);
      if (listPatch.update.done)     lines.push(`  Что сделано: ${listPatch.update.done}`);
      if (listPatch.update.artifact) lines.push(`  Артефакт: ${listPatch.update.artifact}`);
    }
  }

  if (patch.search) {
    if (patch.search.innovations_week !== undefined)
      lines.push(`🔍 <b>Поиск:</b> ${patch.search.innovations_week} инноваций за неделю`);
    if (patch.search.items) {
      [].concat(patch.search.items).forEach(item => {
        lines.push(`  + <b>${item.name}</b>`);
        if (item.done)     lines.push(`    ${item.done}`);
        if (item.artifact) lines.push(`    Артефакт: ${item.artifact}`);
      });
    }
  }

  if (patch.infra) {
    if (patch.infra.done)
      [].concat(patch.infra.done).forEach(s => lines.push(`🏗️ <b>Инфра:</b> ${s}`));
    if (patch.infra.artifacts)
      [].concat(patch.infra.artifacts).forEach(s => lines.push(`    Артефакт: ${s}`));
  }

  if (patch.vnd) {
    if (patch.vnd.no_data)
      lines.push(`📋 <b>ВНД:</b> нет данных — ${patch.vnd.no_data_reason || ''}`);
    if (patch.vnd.items)
      [].concat(patch.vnd.items).forEach(item => {
        lines.push(`📋 <b>ВНД:</b> ${item.name || ''}`);
        if (item.done) lines.push(`    ${item.done}`);
      });
  }

  if (patch.budget) {
    const b = patch.budget;
    if (b.total) {
      const t = b.total;
      const parts = [];
      if (t.spent     !== undefined) parts.push(`факт ${t.spent} млн`);
      if (t.spent_pct !== undefined) parts.push(`${t.spent_pct}%`);
      if (t.remaining !== undefined) parts.push(`остаток ${t.remaining} млн`);
      lines.push(`💰 <b>Бюджет TOTAL:</b> ${parts.join(' · ')}`);
    }
    ['capex','opex','fot'].forEach(cat => {
      if (!b[cat]) return;
      Object.entries(b[cat]).forEach(([q, v]) => {
        const parts = [];
        if (v.spent   !== undefined) parts.push(`факт ${v.spent}`);
        if (v.planned !== undefined) parts.push(`план ${v.planned}`);
        lines.push(`  ${cat.toUpperCase()} ${q.toUpperCase()}: ${parts.join(' / ')}`);
      });
    });
  }

  if (patch.pr) {
    if (patch.pr.focus)           lines.push(`📣 <b>PR фокус:</b> ${patch.pr.focus}`);
    if (patch.pr.community_total) lines.push(`    Сообщество: ${patch.pr.community_total}`);
    if (patch.pr.media_internal)  lines.push(`    Публикации внутри: ${patch.pr.media_internal}`);
    if (patch.pr.media_external)  lines.push(`    Публикации внешние: ${patch.pr.media_external}`);
    if (patch.pr.cards) {
      [].concat(patch.pr.cards).forEach(c => {
        lines.push(`  + ${c.title || c.type || 'Активность'}`);
        if (c.done)     lines.push(`    ${c.done}`);
        if (c.artifact) lines.push(`    Артефакт: ${c.artifact}`);
      });
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'Данные будут обновлены';
}

// ── Claude system prompt ──────────────────────────────────────────────────────

function systemPrompt(data, firstName, extraNote) {
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

💰 <b>Бюджет</b> — исполнение бюджета АИ (данные нарастающим итогом, не сбрасываются):
  · Обновить общие данные (TOTAL): потраченную сумму, %, остаток
  · Обновить квартальные данные по CAPEX / OPEX / ФОТ: факт и план по нужному кварталу
  · Все суммы в млн руб.

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

━━━ ТЕКУЩИЕ ДАННЫЕ (Н${data.meta.week}) ━━━
Поиск: ${data.search.innovations_week} инноваций на неделе, ${data.search.innovations_base} в базе
Конвейер: ${data.pilots.active.length} активных + ${data.pilots.control.length} на контроле

${pilots}

━━━ ОБНОВЛЕНИЕ ДАННЫХ ━━━
Данные НАКАПЛИВАЮТСЯ внутри недели:
· Поля "done" и "artifact" у активных пилотов — дописываются через " · "
· Массивы infra.done, infra.artifacts, search.items, pr.cards, vnd.items — пополняются
· Начинай новую запись с даты: "07.07 — текст"
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
· ВНД нет данных: { "vnd": { "no_data": true, "no_data_reason": "Отпуск: Иванов" } }
· Бюджет TOTAL: { "budget": { "total": { "spent": 55.0, "spent_pct": 15.7, "remaining": 294.9, "remaining_pct": 84.3 } } }
· Бюджет квартал: { "budget": { "opex": { "q3": { "spent": 5.2 } } } }
· Бюджет ФОТ квартал: { "budget": { "fot": { "q3": { "spent": 12.5, "planned": 40.2 } } } }

━━━ РЕЖИМ ПРАВКИ ($set) ━━━
Если пользователь хочет ИСПРАВИТЬ (а не дополнить) уже записанный текст — используй флаг "$set": true:
{ "pilots": { "active": { "find": "АИ.П26.28", "$set": true, "update": { "done": "07.07 — исправленный текст", "artifact": "Новый артефакт" } } } }
Это полностью заменит текущее значение поля, а не дополнит его.
Используй $set когда: пользователь говорит «исправь», «замени», «перепиши», «правка», «было неверно».${extraNote ? '\n\n' + extraNote : ''}`;
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
        const isSet = !!listPatch['$set'];

        for (const [field, newVal] of Object.entries(listPatch.update)) {
          if (isSet) {
            // Explicit overwrite (edit/correction mode)
            pilot[field] = newVal;
          } else if (field === 'done' && typeof newVal === 'string') {
            // First update this week for active pilots: clear inherited artifact
            if (listKey === 'active' && !pilot.done) {
              pilot.artifact = '';
            }
            pilot.done = appendStr(pilot.done, newVal);
          } else if (field === 'artifact' && typeof newVal === 'string') {
            pilot.artifact = appendStr(pilot.artifact, newVal);
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

    } else if (key === 'budget' && typeof val === 'object') {
      if (!d.budget) d.budget = {};
      for (const [section, sectionVal] of Object.entries(val)) {
        if (!d.budget[section]) d.budget[section] = {};
        if (typeof sectionVal === 'object' && !Array.isArray(sectionVal)) {
          for (const [subKey, subVal] of Object.entries(sectionVal)) {
            if (typeof subVal === 'object' && !Array.isArray(subVal) && typeof d.budget[section][subKey] === 'object') {
              // Quarter-level: merge individual fields (spent, planned) without losing the other
              Object.assign(d.budget[section][subKey], subVal);
            } else {
              d.budget[section][subKey] = subVal;
            }
          }
        } else {
          d.budget[section] = sectionVal;
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

const SAVE_WORDS  = ['да', 'ок', 'ok', '+', '👍', 'yes', 'сохранить', 'ладно', 'записать', 'верно', 'правильно'];
const EDIT_WORDS  = ['изменить', 'нет', 'исправить', 'правка', 'отмена', 'cancel', 'edit', 'не то', 'неверно'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const msg = update?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId    = msg.chat.id;
  const userId    = String(msg.from?.id || '');
  const text      = msg.text || '';
  const firstName = msg.from?.first_name || '';
  const isGroup   = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const BOT_USERNAME = 'reacto_robot';
  const BOT_ID       = 8957784340;

  if (isGroup) {
    const mentionsBot = text.toLowerCase().includes(`@${BOT_USERNAME}`) || text.toLowerCase().includes('реактор');
    const replyToBot  = msg.reply_to_message?.from?.id === BOT_ID;
    if (!mentionsBot && !replyToBot) return res.status(200).json({ ok: true });
  }

  const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await tgSend(chatId, '⛔ Нет доступа.');
    return res.status(200).json({ ok: true });
  }

  const [stateResult, dataResult] = await Promise.all([getState(), getDataJson()]);
  const { conversations, sha: stateSha } = stateResult;
  const { data, sha: dataSha } = dataResult;

  if (!conversations[userId]) conversations[userId] = { messages: [], pendingPatch: null, editMode: false };
  const conv = conversations[userId];

  const lc = cleanText.toLowerCase().trim();

  // ── Handle pending confirmation ───────────────────────────────────────────
  if (conv.pendingPatch) {
    const isSave = SAVE_WORDS.some(w => lc === w);
    const isEdit = EDIT_WORDS.some(w => lc === w);

    if (isSave) {
      const { patch, confirmText } = conv.pendingPatch;
      const newData = applyPatch(data, patch);
      const ok = await putDataJson(newData, dataSha, `feat: update via bot — ${confirmText}`);
      conv.pendingPatch = null;
      conv.editMode = false;
      if (ok) {
        // Keep last 6 messages for context continuity
        conv.messages = conv.messages.slice(-6);
        await tgSend(chatId, `✅ ${confirmText}\n\n🔗 <a href="https://accelerator-weekly-new.vercel.app">Открыть дашборд (текущая неделя)</a>`);
      } else {
        await tgSend(chatId, '❌ Не удалось сохранить в GitHub. Попробуй ещё раз.');
      }
      await saveState(conversations, stateSha);
      return res.status(200).json({ ok: true });
    }

    if (isEdit) {
      conv.pendingPatch = null;
      conv.editMode = true;
      await tgSend(chatId, '✏️ Хорошо. Отправь исправленный текст — запишу его целиком, без добавления к старому.');
      await saveState(conversations, stateSha);
      return res.status(200).json({ ok: true });
    }

    // Unrelated message: clear pending and proceed as new request
    conv.pendingPatch = null;
  }

  // ── Add user message to history ───────────────────────────────────────────
  conv.messages.push({ role: 'user', content: cleanText || text });

  // Keep last 20 messages
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  // ── Call Claude ───────────────────────────────────────────────────────────
  const extraNote = conv.editMode
    ? '⚠️ РЕЖИМ ПРАВКИ АКТИВЕН: для следующего патча ОБЯЗАТЕЛЬНО используй "$set": true.'
    : null;

  let claudeReply = '';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt(data, firstName, extraNote),
      messages: conv.messages,
    });
    claudeReply = response.content[0].text;
  } catch (err) {
    await tgSend(chatId, `❌ Ошибка Claude: ${err.message}`);
    return res.status(200).json({ ok: true });
  }

  // ── Process Claude response ───────────────────────────────────────────────
  const patchMatch   = claudeReply.match(/PATCH:\s*```json\s*([\s\S]+?)```/);
  const confirmMatch = claudeReply.match(/CONFIRM:\s*(.+)/);

  if (patchMatch) {
    try {
      const patch       = JSON.parse(patchMatch[1]);
      const confirmText = confirmMatch?.[1]?.trim() || 'Дашборд обновлён';

      // Store pending patch — don't save yet
      conv.pendingPatch = { patch, confirmText };
      conv.editMode     = false;

      // Add cleaned reply to history (without the raw PATCH block)
      const historyReply = confirmText;
      conv.messages.push({ role: 'assistant', content: historyReply });

      const preview = previewPatch(patch, data);
      await tgSend(chatId,
        `📋 <b>Проверьте перед сохранением:</b>\n\n${preview}\n\n` +
        `<i>Ответьте <b>да</b> — сохранить, <b>изменить</b> — скорректировать текст</i>`
      );
    } catch (err) {
      await tgSend(chatId, `❌ Ошибка при разборе патча: ${err.message}`);
    }
  } else {
    // Regular conversation — send Claude reply as-is
    conv.messages.push({ role: 'assistant', content: claudeReply });
    await tgSend(chatId, claudeReply);
  }

  await saveState(conversations, stateSha);
  return res.status(200).json({ ok: true });
}
