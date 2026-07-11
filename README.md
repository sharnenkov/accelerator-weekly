# Еженедельный дашборд · ЦИР

Система еженедельной отчётности для команды — дашборд + Telegram-бот для ввода данных. Данные хранятся в GitHub, дашборд деплоится на Vercel, бот работает как Vercel Serverless Function.

---

## Архитектура

```
Telegram-бот (@reacto_robot)
    │  пишет через GitHub Contents API
    ▼
GitHub репозиторий
    ├── data-new.json   ← текущая неделя (WIP, редактируется)
    ├── data.json       ← опубликованная неделя (факт, только чтение)
    ├── archive/        ← архив по неделям (week-27.json, …)
    ├── state.json      ← состояние диалогов бота
    └── index.html      ← весь фронтенд (один файл)
         │
         │  читает через raw.githubusercontent.com
         ▼
Vercel (два деплоя из одного репо)
    ├── project-weekly.vercel.app       → data.json    (опубликованный факт)
    └── project-weekly-new.vercel.app   → data-new.json (WIP текущей недели)

GitHub Actions (каждый понедельник 06:00 МСК)
    └── weekly-publish.yml → архивирует, продвигает WIP в факт, генерирует шаблон след. недели
```

**Ключевой принцип:** данные живут в GitHub, дашборд — статический HTML без бэкенда. Vercel нужен только для хостинга HTML и для webhook-функции бота.

---

## Структура файлов

```
├── index.html                  # Весь фронтенд — один файл, читает JSON с GitHub
├── data.json                   # Опубликованные данные текущей недели
├── data-new.json               # WIP-данные (заполняется через бота)
├── state.json                  # Состояние диалогов бота (авто, не редактировать)
├── og.png                      # OG-превью для соцсетей / мессенджеров
├── package.json                # Зависимость: @anthropic-ai/sdk
├── vercel.json                 # Настройки Vercel (rewrites + функция бота)
├── api/
│   └── webhook.js              # Telegram webhook → Claude Haiku → GitHub API
├── archive/
│   └── week-NN.json            # Архив опубликованных недель
└── .github/
    └── workflows/
        └── weekly-publish.yml  # Еженедельная публикация
```

---

## Разделы дашборда

| # | Раздел | Ключ в JSON | Описание |
|---|--------|-------------|----------|
| 1 | 💰 Бюджет | `budget` | TOTAL / CAPEX / OPEX / ФОТ по кварталам, нарастающим итогом |
| 2 | 🔍 Поиск инноваций | `search` | Новые решения за неделю, счётчик базы |
| 3 | ⚙️ Конвейер пилотов | `pilots` | Активные пилоты + пилоты на контроле, воронка |
| 4 | 🏗️ Инфраструктура | `infra` | Технические задачи команды |
| 5 | 📋 ВНД | `vnd` | Методология и регламенты |
| 6 | 📣 PR | `pr` | Публикации, сообщество, события |

---

## Структура data.json / data-new.json

```jsonc
{
  "meta": { "week": 28, "date": "5 июля 2026", "updated": "..." },

  "budget": {
    "total": { "budget": 349.9, "spent": 42.5, "spent_pct": 12.2, "remaining": 307.4, "remaining_pct": 87.7 },
    "capex": { "q1": { "spent": 0, "planned": 0 }, "q2": {…}, "q3": {…}, "q4": {…} },
    "opex":  { "q1": {…}, "q2": {…}, "q3": {…}, "q4": {…} },
    "fot":   { "q1": {…}, "q2": {…}, "q3": {…}, "q4": {…} }
  },

  "search": {
    "innovations_week": 3,          // новых за неделю
    "innovations_base": 160,         // всего в базе (накопительно, не сбрасывается)
    "items": [
      { "id": "u1", "name": "Название", "desc": "Описание", "done": "07.07 — ...", "artifact": "..." }
    ]
  },

  "pilots": {
    "funnel": { "entry": 4, "waiting": 3, "assembly": 16, "testing": 3, "completion": 2 },
    "active": [
      { "id": "АИ.П26.01", "name": "Название пилота", "stage": "Комплектация", "done": "07.07 — ...", "artifact": "..." }
    ],
    "control": [
      { "id": "АИ.П26.03", "name": "...", "stage": "Тестирование", "artifact": "...", "done": "" }
    ]
  },

  "infra": {
    "title": "Развитие инфраструктуры",
    "done": ["07.07 — Настроен доступ к LLM"],
    "artifacts": ["Инструкция по подключению"]
  },

  "vnd": {
    "title": "Порядок работы",
    "no_data": false,
    "no_data_reason": "",
    "items": [{ "name": "Название документа", "done": "...", "artifact": "..." }]
  },

  "pr": {
    "focus": "Ключевой фокус недели",
    "media_internal": 2,
    "media_external": 1,
    "community_new": 5,
    "community_total": 104,
    "cards": [{ "type": "community", "title": "...", "done": "...", "artifact": "..." }],
    "next_event": { "title": "...", "date": "15.07.2026" }
  }
}
```

### Правила накопления данных

| Поле | Поведение |
|------|-----------|
| `pilots.active[].done` | Дописывается через ` · ` внутри недели; при первом `done` унаследованный `artifact` очищается |
| `pilots.active[].artifact` | Дописывается через ` · ` |
| `pilots.control[].artifact` | Наследуется из предыдущей недели; дописывается |
| `search.innovations_base` | Накопительно — не сбрасывается |
| `budget.*` | Нарастающим итогом — не сбрасывается при публикации |
| `search.items`, `infra.done`, `pr.cards`, `vnd.items` | Массивы — пополняются, каждую неделю очищаются |

---

## Еженедельный workflow (GitHub Actions)

Запускается каждый **понедельник в 06:00 МСК** (или вручную через `workflow_dispatch`).

**Шаги:**

1. **Guard** — пропускает, если `data-new.week <= data.week` (защита от двойной публикации)
2. **Архив** — сохраняет `data.json` → `archive/week-NN.json`
3. **Наследование артефактов** — контрольные пилоты без артефакта получают его из прошлой недели
4. **Миграция активных → контроль** — пилоты без `done` за неделю переходят в контроль
5. **Продвижение** — `data-new.json` → `data.json`
6. **Новый шаблон** — генерирует `data-new.json` для следующей недели:
   - активные пилоты: `done` и `artifact` очищаются
   - контрольные пилоты: только `done` очищается, `artifact` сохраняется
   - `budget` не трогается (нарастающий итог)
   - `search.items`, `infra.done/artifacts`, `vnd.items`, `pr.cards` очищаются

---

## Telegram-бот (@reacto_robot)

**Стек:** Vercel Serverless Function → Claude Haiku → GitHub Contents API

### Команды

| Команда | Кто | Описание |
|---------|-----|----------|
| `/id` | все | Показывает `chat_id` и `user_id` текущего чата |
| `/msg <chat_id> <текст>` | только admin | Отправляет сообщение в указанный чат (с превью и подтверждением) |

### Флоу добавления данных

```
Оператор пишет боту
    │
    ▼
Claude Haiku уточняет раздел/пилот, спрашивает артефакт
    │
    ▼
Бот показывает превью: «📋 Проверьте перед сохранением»
    │
  да │ изменить
    │         └─→ «Отправь исправленный текст» (режим $set — замена вместо дописывания)
    ▼
GitHub Contents API обновляет data-new.json
    │
    ▼
Vercel CDN раздаёт обновлённый дашборд
```

### Режим правки ($set)

Если нужно **заменить** (а не дописать) уже записанный текст — сказать боту «исправь», «замени», «перепиши». Следующий патч использует `$set: true` и перезаписывает поле целиком.

### Контекст диалога

- Хранится в `state.json` в репозитории
- Последние **20 сообщений** на пользователя
- После успешного сохранения остаются **6 сообщений** (не сбрасывается в 0)

---

## Переменные окружения (Vercel)

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_TOKEN` | Токен бота от @BotFather |
| `ANTHROPIC_API_KEY` | Ключ Anthropic API |
| `GITHUB_TOKEN` | Personal Access Token с правом `Contents: write` на репо |
| `ALLOWED_TELEGRAM_IDS` | Comma-separated список user_id, которым разрешён доступ к боту (пусто = все) |

---

## Два деплоя из одного репо

Дашборд определяет, какой файл читать, по hostname:

```javascript
const IS_NEW = window.location.hostname.includes('-new') ||
               window.location.search.includes('new=1');
const file = IS_NEW ? 'data-new.json' : 'data.json';
```

Оба деплоя — один и тот же `index.html`, только данные разные.

**Настройка доменов как постоянных production-алиасов:**
```bash
vercel domains add project-weekly.vercel.app
vercel domains add project-weekly-new.vercel.app
```

---

## Как развернуть копию для другого проекта

1. **Fork репозитория** или скопировать файлы в новый репо
2. **Создать Telegram-бота** через @BotFather → получить токен
3. **Создать GitHub PAT**: Settings → Developer settings → Personal access tokens → `Contents: write` на новый репо
4. **Создать проект в Vercel**: импортировать репо, добавить переменные окружения
5. **Настроить webhook** Telegram:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<vercel-domain>/api/webhook
   ```
6. **Создать второй Vercel-деплой** (тот же репо, другое имя проекта) — для `-new` версии
7. **Адаптировать данные**: отредактировать `data.json` и `data-new.json` под новый проект — секции, пилоты, аббревиатуры
8. **Обновить системный промпт бота** в `api/webhook.js` — название проекта, логику разделов
9. **Запустить первый GitHub Action** вручную (`workflow_dispatch`) чтобы проверить публикацию

---

## Коллабораторы

| GitHub | Роль |
|--------|------|
| @sharnenkov | Owner |
| @kostyuksergey | Write (разработка дашборда) |
