# НарядAI — документация для фронтенда

Всё, что нужно мобильному приложению (мастер, исполнитель) и веб-панели (руководитель, админ). Форматы ответов сняты с работающего API, а не написаны по памяти. Готовые TypeScript-типы лежат в [frontend-types.ts](frontend-types.ts).

## Содержание

1. [Подключение](#1-подключение)
2. [Общие правила](#2-общие-правила)
3. [Вход и сессия](#3-вход-и-сессия)
4. [Роли и экраны](#4-роли-и-экраны)
5. [Наряды](#5-наряды)
6. [Действия по наряду](#6-действия-по-наряду)
7. [Офлайн-очередь](#7-офлайн-очередь)
8. [Фото](#8-фото)
9. [Голосовой ввод](#9-голосовой-ввод)
10. [AI-проверка: как показывать](#10-ai-проверка-как-показывать)
11. [Realtime (Socket.IO)](#11-realtime-socketio)
12. [Push-уведомления (FCM)](#12-push-уведомления-fcm)
13. [Уведомления в приложении](#13-уведомления-в-приложении)
14. [Справочники](#14-справочники)
15. [Оборудование и QR](#15-оборудование-и-qr)
16. [Рекомендации и AI-помощник](#16-рекомендации-и-ai-помощник)
17. [Аналитика, отчёты, выгрузки](#17-аналитика-отчёты-выгрузки)
18. [Администрирование](#18-администрирование)
19. [Ошибки](#19-ошибки)
20. [Готовый API-клиент](#20-готовый-api-клиент)
21. [Чек-лист интеграции](#21-чек-лист-интеграции)

---

## 1. Подключение

| | |
|---|---|
| Базовый URL | `http://<сервер>:8765`; все пути ниже относительно него |
| Формат | JSON, `Content-Type: application/json`; загрузка файлов — `multipart/form-data` |
| CORS | разрешены любые origin, `credentials: true` |
| Авторизация | `Authorization: Bearer <JWT>` |
| Realtime | Socket.IO на том же адресе |
| Проверка | `GET /health` → `{"status":"ok"}`; `GET /health/ready` → `{"database":true,"ollama":true}` (503, если AI недоступен) |

Тестовые аккаунты входят по телефону: `+77000000001` — мастер, `+77000000002` — руководитель, `+77000000003` — админ, `+77000000101` … `+77000000115` — исполнители 1–15. Пароли выдаёт администратор: они лежат в `demo-credentials.local.txt` на сервере и в git не хранятся.

---

## 2. Общие правила

- **Даты** — ISO 8601 в UTC (`"2026-10-05T17:35:16.419Z"`). Отправлять тоже ISO, например `new Date().toISOString()`.
- **Десятичные числа приходят строками:** `hours`, `quantity`, `_sum.quantity` выглядят как `"2"`, `"1.5"`. Перед вычислениями делайте `Number(x)`. Отправлять их нужно числами.
- **id** — целые числа.
- `null` означает «не заполнено»; поля не пропускаются.
- **Ошибки** всегда приходят в виде `{ "error": "Текст по-русски" }`, иногда с `details` (см. [§19](#19-ошибки)). Текст `error` можно показывать пользователю как есть.
- **Язык интерфейса** берите из `user.language` (`"ru"` или `"kk"`). Тексты ошибок и AI-ответы сервер отдаёт по-русски.

---

## 3. Вход и сессия

### `POST /api/auth/login`

Вход — по **номеру телефона и паролю**.

```json
{ "phone": "+7 701 234 56 78", "password": "secret12" }
```
Ответ `200`:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "user": { "id": 5, "fullName": "Исполнитель 2", "phone": "+77012345678", "role": "EXECUTOR", "employeeStatus": "AVAILABLE" }
}
```

**Телефон** можно отправлять в любой привычной записи — сервер сам приведёт его к виду `+7XXXXXXXXXX`:
`+7 (701) 234-56-78`, `8 701 234 56 78`, `87012345678`, `7012345678` → `+77012345678`. Номера других стран — с `+` и кодом страны. В поле ввода удобно ставить маску `+7 (___) ___-__-__` и клавиатуру `phone-pad`.

**Пароль** — от 6 до 128 любых символов. Правило «от 6» проверяется при создании и смене пароля; при входе сервер принимает пароль любой длины, чтобы не заблокировать старые аккаунты.

| Ответ | Что показать |
|---|---|
| `401 {"error":"Неверный номер телефона или пароль"}` | этот текст |
| `429` + заголовок `Retry-After: <секунды>` | «Слишком много попыток. Повторите через N мин.» и заблокировать кнопку на время из заголовка |
| `400`, в `details` — «Неверный номер телефона» | номер короче 10 или длиннее 15 цифр — подсветить поле телефона |
| `400` без `details` про телефон | пустой пароль |

- После **5 неверных паролей** номер блокируется на 15 минут — **даже верный пароль** в это время вернёт 429. Разные записи одного номера (`8 701…` и `+7 701…`) считаются одним номером.
- Если с одного устройства или IP было **30 неудач**, блокируется IP.
- Токен живёт **12 часов** (одна смена). Обновления токена нет: при любом `401` на защищённом запросе отправляйте пользователя на экран входа.
- Храните токен в защищённом хранилище (Keychain / Keystore / `SecureStore`), не в `localStorage` веб-панели, если есть возможность.

### `GET /api/auth/me`

```json
{ "id": 5, "login": "worker2", "phone": "+77012345678", "fullName": "Исполнитель 2", "role": "EXECUTOR", "specialty": "Сварщик",
  "grade": 5, "brigadeId": 3, "employeeStatus": "AVAILABLE", "isOnShift": true, "language": "ru" }
```
`login` — внутренний идентификатор (для 1С), для входа не используется.

### Смена пароля — `POST /api/auth/change-password`

```json
{ "currentPassword": "secret12", "newPassword": "newSecret1" }
```
| Ответ | Что показать |
|---|---|
| `204` | «Пароль изменён». Токен остаётся рабочим, перелогиниваться не нужно |
| `400 Текущий пароль указан неверно` | подсветить поле текущего пароля. Это **не 401**, выкидывать на экран входа не нужно |
| `400`, в `details` — «Пароль должен быть не короче 6 символов» | подсветить новый пароль |

Забытый пароль сбрасывает администратор (`PATCH /api/admin/users/:id` с `password`), восстановления по SMS нет.

### Выход

Сессии на сервере нет — просто удалите токен. Перед этим **отвяжите push-токен**: `DELETE /api/devices/:token` (см. [§12](#12-push-уведомления-fcm)).

---

## 4. Роли и экраны

| Роль `role` | Приложение | Видит наряды | Основные действия |
|---|---|---|---|
| `EXECUTOR` | мобильное | **только свои** (сервер фильтрует сам) | принять, в очередь, отказаться, начать, пауза, продолжить, завершить |
| `MASTER` | мобильное и веб | все | создать, изменить, переназначить, закрыть, вернуть на доработку, отменить; аналитика |
| `MANAGER` | веб | все | аналитика, отчёты, рейтинги, мониторинг 1С |
| `ADMIN` | веб | все | всё, что может мастер, плюс справочники, пользователи, смены |

Если запрос не разрешён роли, сервер отвечает `403 {"error":"Недостаточно прав"}`. Скрывайте недоступные кнопки заранее по `role`.

### Доступ по группам запросов

| Запросы | `EXECUTOR` | `MASTER` | `MANAGER` | `ADMIN` |
|---|:-:|:-:|:-:|:-:|
| `auth/me`, `notifications`, `devices`, `uploads`, `ai/transcribe` | ✅ | ✅ | ✅ | ✅ |
| `references/*`, `equipment/*` | ✅ | ✅ | ✅ | ✅ |
| `assistant/*`, `recommendations/*` | ✅ | ✅ | ✅ | ✅ |
| `GET work-orders`, `GET work-orders/board`, `GET work-orders/:id`, `GET work-orders/:id/report`, `POST work-orders/:id/comment` | свои | ✅ | ✅ | ✅ |
| `POST work-orders`, `PATCH work-orders/:id`, `reassign` | — | ✅ | — | ✅ |
| `GET reports/my-rating` | ✅ | ✅ | ✅ | ✅ |
| `analytics/*`, остальные `reports/*` | — | ✅ | ✅ | ✅ |
| `integrations/*` (панель 1С) | — | — | ✅ | ✅ |
| `admin/*` | — | — | — | ✅ |

### Экраны и запросы

| Экран | Роль | Запросы |
|---|---|---|
| Вход | все | `POST /api/auth/login` → `GET /api/auth/me` → `POST /api/devices` |
| Очередь исполнителя | `EXECUTOR` | `GET /api/work-orders?compact=1&status=ISSUED,QUEUED,ACCEPTED,IN_PROGRESS,PAUSED,REWORK`; Socket.IO `work-order:changed` |
| Карточка наряда | все | `GET /api/work-orders/:id`; кнопки — `POST /api/work-orders/:id/action`; комментарий — `POST /api/work-orders/:id/comment` |
| Моя оценка по наряду | `EXECUTOR` | `GET /api/work-orders/:id/report` |
| Мой рейтинг | `EXECUTOR` | `GET /api/reports/my-rating?period=month` |
| Завершение работ | `EXECUTOR` | `GET /api/references/fault-codes`, `/materials`, `/normatives?equipmentId=`; `POST /api/uploads`; `POST /api/ai/transcribe`; `action: COMPLETE` |
| Панель смены (канбан + счётчики) | `MASTER` | `GET /api/work-orders/board?areaId=…`; `GET /api/references/executors?onShift=1`; Socket.IO `work-order:changed` |
| Список нарядов мастера | `MASTER` | `GET /api/work-orders?compact=1&status=…&areaId=…&equipmentId=…&priority=…&overdue=1` с `limit`/`offset` |
| Создание наряда | `MASTER` | `/api/references/areas`, `/equipment?areaId=`, `/executors`, `/brigades`, `/normatives?equipmentId=`; `GET /api/recommendations/executors`; `POST /api/recommendations/work`; `POST /api/uploads`; `POST /api/work-orders` |
| Проверка закрытия | `MASTER` | `GET /api/work-orders?status=AI_REVIEW`; `GET /api/work-orders/:id/report`; `action: CLOSE` / `SEND_TO_REWORK` |
| Сканер QR | все | `GET /api/equipment/qr/:token` → `GET /api/equipment/:id/history` |
| Уведомления | все | `GET /api/notifications`, `PATCH /api/notifications/:id/read`; Socket.IO `notification:new` |
| AI-помощник | `MASTER` | `POST /api/assistant/chat`, `GET /api/assistant/history` |
| Дашборд | `MANAGER`, `MASTER` | `GET /api/analytics/dashboard`, `/failure-forecast`, `/anomalies` |
| Отчёты и рейтинги | `MANAGER`, `MASTER` | `GET /api/reports/*`, `export.xlsx`, `export.pdf` |
| Справочники и пользователи | `ADMIN` | `GET /api/references/*`, `GET /api/admin/users`, `POST`/`PATCH`/`DELETE /api/admin/*` |
| Смены | `ADMIN` | `GET /api/admin/users`, `PATCH /api/admin/users/:id/shift` |
| Интеграция 1С | `ADMIN`, `MANAGER` | `GET /api/integrations/1c/jobs`, `/1c/mappings`, `POST /1c/run`, `/1c/jobs/:id/retry`, `/1c/push/orders` |

---

## 5. Наряды

### Статусы

| `status` | Показать | Цвет-подсказка |
|---|---|---|
| `ISSUED` | Выдан | синий |
| `QUEUED` | В очереди | серо-синий |
| `ACCEPTED` | Принят | синий |
| `IN_PROGRESS` | В работе | зелёный |
| `PAUSED` | Приостановлен | жёлтый |
| `COMPLETED` | Выполнен (идёт AI-проверка) | — краткий, сразу переходит в `AI_REVIEW` |
| `AI_REVIEW` | На проверке у мастера | фиолетовый |
| `REWORK` | На доработке | оранжевый |
| `CLOSED` | Закрыт | серый |
| `REJECTED` | Отклонён исполнителем | красный |
| `CANCELLED` | Отменён | серый |

**Приоритет** `priority`: `EMERGENCY` (аварийный), `HIGH`, `NORMAL`, `PLANNED`. **Тип** `type`: `EMERGENCY` (аварийный) или `PLANNED` (плановый).

### Список — `GET /api/work-orders`

| Параметр | Описание |
|---|---|
| `status` | один или несколько через запятую: `?status=ISSUED,QUEUED,ACCEPTED` |
| `priority` | один или несколько через запятую: `?priority=EMERGENCY,HIGH` |
| `type` | `EMERGENCY` или `PLANNED` |
| `overdue` | `1` — только просроченные незакрытые |
| `areaId`, `equipmentId`, `assigneeId`, `brigadeId` | фильтры (исполнителю `assigneeId` не нужен — сервер и так отдаёт только его наряды; `brigadeId` — наряды, выданные бригаде, и наряды её членов) |
| `limit` | 1–500, по умолчанию 200 |
| `offset` | смещение для постраничной загрузки |
| `compact` | `1` — облегчённый список без `photos`, `materialUsages`, `creator`, без полной AI-оценки. **Используйте для очереди исполнителя:** быстрее в 4 раза |

- Общее количество записей приходит в заголовке **`X-Total-Count`**.
- Сортировка: сначала по приоритету (аварийные первыми), затем по сроку.
- Неизвестное значение в `status`, `priority` или `type` → `400`.
- В каждом элементе есть признак **`isOverdue`** (срок прошёл, наряд не закрыт): красная метка в списке.

Элемент `compact=1`:
```json
{
  "id": 76, "number": "H-0076", "type": "EMERGENCY", "description": "Шум подшипника",
  "priority": "EMERGENCY", "deadline": "2026-07-21T17:43:25.405Z", "status": "IN_PROGRESS",
  "comment": null, "completionText": null, "pauseReason": null, "rejectionReason": null,
  "createdAt": "…", "updatedAt": "…", "acceptedAt": "…", "startedAt": "…", "completedAt": null, "closedAt": null,
  "areaId": 3, "equipmentId": 2, "creatorId": 1, "assigneeId": 5, "faultCodeId": null, "normativeId": 7,
  "actualDowntimeMinutes": null,
  "area": { "id": 3, "name": "Ремонтно-механический цех" },
  "equipment": { "id": 2, "name": "Дробилка Д-2", "inventoryNumber": "INV-002", "type": "Дробилка", "criticality": 3, "qrToken": "5823…", "areaId": 3 },
  "assignee": { "id": 5, "fullName": "Исполнитель 2", "specialty": "Сварщик", "employeeStatus": "BUSY" },
  "faultCode": null,
  "brigadeId": null, "brigade": null,
  "aiAssessment": { "verdict": "ACCEPTED", "score": 5, "masterScore": null, "needsMasterReview": false },
  "isOverdue": false
}
```
Без `compact` в элементе дополнительно есть `creator`, `normative`, `downtime`, `photos[]`, `materialUsages[]` и полная `aiAssessment`.

### Панель смены — `GET /api/work-orders/board`

Канбан для мастера (кейс, 5.2): колонки и счётчики смены одним запросом. Фильтры те же, что у списка (`areaId`, `equipmentId`, `assigneeId`, `brigadeId`, `priority`, `type`), плюс `hours` — длина смены для счётчиков (по умолчанию 12).

```json
{
  "since": "2026-10-07T03:00:00.000Z",
  "counters": { "issued": 14, "completed": 9, "overdue": 2, "equipmentInDowntime": 1 },
  "columns": {
    "issued": [/* компактные наряды */], "accepted": [], "inProgress": [], "queued": [],
    "completed": [], "overdue": []
  }
}
```
- `inProgress` — `IN_PROGRESS`, `PAUSED`, `REWORK`; `completed` — `COMPLETED`, `AI_REVIEW` и закрытые за смену.
- Просроченный наряд есть **и** в своей колонке, **и** в `overdue`.
- Обновляйте по событию Socket.IO `work-order:changed` (не чаще раза в секунду).

### Карточка — `GET /api/work-orders/:id`

Полный наряд и журнал `events[]` в хронологическом порядке:
```json
{
  "...": "все поля наряда, как в полном списке",
  "photos": [{ "id": 545, "type": "BEFORE", "fileUrl": "/uploads/8e3a…?exp=1791828000&sig=dE5Z…", "capturedAt": "…", "authorId": 1 }],
  "materialUsages": [{ "materialId": 1, "quantity": "1", "material": { "id": 1, "name": "Подшипник 6205", "unit": "шт" } }],
  "aiAssessment": { "verdict": "ACCEPTED", "score": 5, "explanation": "…", "strengths": ["…"], "improvements": [], "photoScore": 4, "photoComment": "…", "confidence": 0.55, "masterScore": null, "masterComment": null },
  "events": [{ "id": 277, "action": "CREATE", "fromStatus": null, "toStatus": "ISSUED", "comment": null, "createdAt": "…", "actor": { "id": 1, "fullName": "Мастер смены" } }]
}
```
`events[].action`: `CREATE`, `ACCEPT`, `QUEUE`, `REJECT`, `START`, `PAUSE`, `RESUME`, `COMPLETE`, `AI_REVIEW`, `SEND_TO_REWORK`, `CLOSE`, `CANCEL`, `EDIT`, `REASSIGN`, `COMMENT`.

В карточке есть **`timing`** — время против норматива и срока:
```json
{ "normativeHours": 2, "actualHours": 2.4, "vsNormativePercent": 120, "deadlineMet": false, "overdueMinutes": 35 }
```
`actualHours` — от начала работ до «Исполнено»; `deadlineMet` — `null`, пока наряд не выполнен.

Ошибки: `404` — нет такого наряда; `403` — исполнитель открыл чужой наряд.

### Отчёт по наряду — `GET /api/work-orders/:id/report`

Ответ зависит от роли (кейс, 6.4):
- **исполнитель** (только свой наряд) — `audience: "EXECUTOR"`: `finalScore` (оценка мастера, если есть, иначе ИИ), `aiScore`, `masterScore`, `verdict`, `explanation`, `strengths[]` («что сделано хорошо»), `improvements[]` («что улучшить»), `masterComment`, `photoComment`, `timing`;
- **мастер, руководитель, админ** — `audience: "MASTER"`: вся карточка плюс `chronology[]` (`at`, `action`, `from`, `to`, `actor`, `comment`), `photosBefore[]`, `photosAfter[]`, `downtimeMinutes`, `timing`, `finalScore`. PDF той же карточки — `GET /api/reports/work-order/:id.pdf`.

### Комментарий — `POST /api/work-orders/:id/comment`

```json
{ "comment": "ждём подшипник со склада", "clientActionId": "…" }
```
Комментарий без смены статуса: исполнитель — к своему наряду, мастер — к любому. Ответ `201 { order }`. Последний комментарий попадает в сообщение о просрочке. `clientActionId` работает как в действиях: повтор вернёт `replayed: true`.

### Создание — `POST /api/work-orders` (мастер, админ)

```json
{
  "type": "EMERGENCY",
  "description": "Шум подшипника насоса",
  "areaId": 2,
  "equipmentId": 1,
  "assigneeId": 5,
  "priority": "EMERGENCY",
  "normativeId": 1,
  "deadline": "2026-10-05T20:00:00.000Z",
  "comment": "Срочно, линия стоит",
  "beforePhotoUrls": ["/uploads/8e3a…?exp=…&sig=…"]
}
```

| Поле | Правило |
|---|---|
| `type`, `priority`, `description` (≥ 3 символов), `areaId`, `equipmentId` | обязательны |
| `assigneeId` **или** `brigadeId` | хотя бы одно. Только `brigadeId` — наряд выдаётся бригаде: старшим сервер назначает лучшего по подбору члена бригады на смене, остальные члены получают уведомление `BRIGADE_ORDER`. Оба поля — исполнитель обязан состоять в бригаде |
| `deadline` **или** `normativeId` | хотя бы одно; без срока он считается как «сейчас + часы норматива» |
| `equipmentId` | должен принадлежать `areaId`, иначе 400 |
| `assigneeId` | только пользователь с ролью `EXECUTOR`, иначе 400 |
| `beforePhotoUrls` | до 5 ссылок из `POST /api/uploads` |

Ответ `201` — полный наряд. Номер присваивается автоматически (`N-xxxxxxxx`).

| Ошибка | Причина |
|---|---|
| `400 Проверьте оборудование и исполнителя` | оборудование не на этом участке или исполнитель не `EXECUTOR` |
| `400 Бригада не найдена` / `В бригаде нет исполнителей на смене` / `Исполнитель не состоит в этой бригаде` | ошибки выдачи бригаде |
| `400 Норматив не найден` | неверный `normativeId` |
| `400 Ошибка в данных запроса` | нет полей, нет ни `deadline`, ни `normativeId` (`details` → «Укажите срок или норматив») |
| `409 Такая запись уже существует` | редкое совпадение номера при двух нарядах в одну миллисекунду — можно повторить |

Побочные эффекты: исполнитель получает уведомление `NEW_ORDER` (для аварийного — push в канал `emergency_orders`), для аварийного **типа** открывается простой оборудования, все мастера и исполнитель получают `work-order:changed`.

> ⚠️ **Создание не идемпотентно**: повторная отправка создаст второй наряд. Не ставьте создание в автоматическую офлайн-очередь без проверки; см. [§7](#7-офлайн-очередь).

**Подсказки для формы создания:**
1. Выбрали оборудование и ввели описание → `GET /api/recommendations/executors?equipmentId=…&description=…` покажет, кого назначить: свободных нужной специальности первыми ([§16](#16-рекомендации-и-ai-помощник)).
2. Ввели описание → `POST /api/recommendations/work` предложит шифр, норматив и часы.
3. Описание можно надиктовать ([§9](#9-голосовой-ввод)).

### Правка — `PATCH /api/work-orders/:id` (мастер, админ)

```json
{ "priority": "HIGH", "deadline": "2026-10-06T08:00:00.000Z", "comment": "Перенос по согласованию" }
```
Все поля необязательны. Ответ — полный наряд. В журнал пишется событие `EDIT`.

Сервер не проверяет статус при правке, поэтому показывайте «Изменить» только для активных нарядов: `ISSUED`, `ACCEPTED`, `QUEUED`, `IN_PROGRESS`, `PAUSED`, `REWORK`.

### Переназначение — `POST /api/work-orders/:id/reassign` (мастер, админ)

```json
{ "assigneeId": 7 }
```
- Наряд возвращается в `ISSUED`, новый исполнитель получает уведомление.
- `400` — новый исполнитель не `EXECUTOR`.
- `409` — наряд в статусе `COMPLETED`, `AI_REVIEW`, `CLOSED` или `CANCELLED`.
- Отклонённый наряд (`REJECTED`) переназначать можно — это обычный сценарий после отказа.

---

## 6. Действия по наряду

Все переходы выполняет один эндпоинт: **`POST /api/work-orders/:id/action`**.

```json
{ "action": "ACCEPT", "clientActionId": "a7f3c1e2-…" }
```

| `action` | Кто | Из статусов | Обязательные поля | Необязательные |
|---|---|---|---|---|
| `ACCEPT` | исполнитель (свой), мастер | `ISSUED`, `QUEUED` | — | `comment` |
| `QUEUE` | исполнитель, мастер | `ISSUED` | — | `comment` |
| `REJECT` | исполнитель, мастер | `ISSUED` | **`comment`** — причина | |
| `START` | исполнитель, мастер | `ACCEPTED`, `QUEUED`, `REWORK` | — | |
| `PAUSE` | исполнитель, мастер | `IN_PROGRESS` | **`comment`** — причина | |
| `RESUME` | исполнитель, мастер | `PAUSED` | — | |
| `COMPLETE` | исполнитель, мастер | `IN_PROGRESS` | см. ниже | |
| `SEND_TO_REWORK` | **мастер, админ** | `AI_REVIEW` | — | `comment` (что исправить) |
| `CLOSE` | **мастер, админ** | `AI_REVIEW` | — | `masterScore` 1–5, `comment`, `actualDowntimeMinutes` |
| `CANCEL` | **мастер, админ** | `ISSUED`, `ACCEPTED`, `QUEUED`, `IN_PROGRESS`, `PAUSED`, `REWORK` | — | `comment` |

Во всех действиях можно передать `clientActionId` (8–100 символов, см. [§7](#7-офлайн-очередь)).

**`COMPLETE`** — тело:
```json
{
  "action": "COMPLETE",
  "completionText": "Заменён подшипник 6205, вибрация 2,1 мм/с в норме",
  "faultCodeId": 1,
  "afterPhotoUrls": ["/uploads/…?exp=…&sig=…"],
  "materials": [{ "materialId": 1, "quantity": 2 }],
  "clientActionId": "…"
}
```
Сервер не отклоняет `COMPLETE` без текста, шифра или фото, но AI-проверка тогда **сразу вернёт наряд на доработку**. Поэтому в форме сделайте обязательными:
- `completionText` — что сделано и как проверено;
- `faultCodeId` — шифр неисправности;
- `afterPhotoUrls` — хотя бы одно фото **для аварийного наряда** (`type: "EMERGENCY"`); для планового необязательно;
- `materials` — если что-то списывали, `quantity` числом.

Ответ на любое действие:
```json
{ "order": { "…полный наряд…" }, "assessment": null }
```
Для `COMPLETE` в `assessment` приходит AI-оценка, а `order.status` уже равен `AI_REVIEW`.

> ⏱ **`COMPLETE` выполняется долго**: сервер ждёт AI-проверку, обычно 4–15 с, в худшем случае до ~4 мин, если модели перегружены. Покажите экран «Проверяем отчёт…» и поставьте таймаут запроса **не меньше 250 с**. Остальные действия выполняются меньше чем за 1 с.

Ошибки действий:

| Код | Пример `error` | Что делать |
|---|---|---|
| 409 | `Переход START недоступен из статуса CLOSED` | обновить карточку — статус уже изменился |
| 400 | `Укажите причину отклонения` / `Укажите причину приостановки` | показать поле причины |
| 403 | `Это не ваш наряд` / `Действие доступно мастеру` | скрыть кнопку |
| 404 | `Наряд не найден` | убрать из списка |

**Какие кнопки показывать** — готовая функция:
```ts
const ALLOWED: Record<WorkOrderAction, WorkOrderStatus[]> = {
  ACCEPT: ["ISSUED", "QUEUED"], QUEUE: ["ISSUED"], REJECT: ["ISSUED"],
  START: ["ACCEPTED", "QUEUED", "REWORK"], PAUSE: ["IN_PROGRESS"], RESUME: ["PAUSED"],
  COMPLETE: ["IN_PROGRESS"], SEND_TO_REWORK: ["AI_REVIEW"], CLOSE: ["AI_REVIEW"],
  CANCEL: ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"]
};
const MASTER_ONLY: WorkOrderAction[] = ["SEND_TO_REWORK", "CLOSE", "CANCEL"];

export function availableActions(order: WorkOrder, user: { id: number; role: Role }): WorkOrderAction[] {
  return (Object.keys(ALLOWED) as WorkOrderAction[]).filter((action) => {
    if (!ALLOWED[action].includes(order.status)) return false;
    if (MASTER_ONLY.includes(action)) return user.role === "MASTER" || user.role === "ADMIN";
    return user.role !== "EXECUTOR" || order.assigneeId === user.id;
  });
}
```

---

## 7. Офлайн-очередь

На участке может не быть связи. Действия по нарядам можно копить и отправлять позже.

1. Для каждого действия **один раз** сгенерируйте `clientActionId` (`crypto.randomUUID()`) и сохраните его вместе с действием в локальной очереди.
2. Отправляйте очередь **по порядку**. При сетевой ошибке повторяйте **с тем же `clientActionId`**.
3. Если сервер уже выполнил это действие, он ответит `200 { "order": …, "replayed": true }` и ничего не изменит. Это успех — удаляйте элемент из очереди.
4. Ответ `409` после восстановления связи означает, что статус успел поменяться (например, мастер отменил наряд). Удалите действие из очереди, обновите карточку и покажите пользователю, что действие не применено.
5. `400` и `403` — ошибки данных или прав; повторять бесполезно.

Что **нельзя** класть в автоматическую очередь:
- **Создание наряда** (`POST /api/work-orders`) — не идемпотентно. Если всё же нужно, перед повтором проверьте список нарядов мастера.
- **Загрузку фото** — повтор создаст ещё один файл. Это безопасно, но расходует место. Фото, снятые офлайн, загружайте при появлении связи **до** отправки `COMPLETE` и подставляйте полученные `url`.

---

## 8. Фото

### Загрузка — `POST /api/uploads`

`multipart/form-data`, поле **`file`**, до **15 МБ**. Сервер сам поворачивает изображение по EXIF, ужимает до 1600 px и сохраняет в JPEG. Из метаданных остаётся **только время съёмки** (GPS, модель телефона и прочее удаляются).

**Время съёмки** нужно для проверки «фото сделано при закрытии, а не старое». Сервер берёт его из EXIF камеры. Если EXIF нет (PWA, некоторые галереи), передайте необязательное поле **`takenAt`** (ISO-дата) — например, `file.lastModified` снимка с камеры.

```ts
const form = new FormData();
form.append("file", { uri, name: "photo.jpg", type: "image/jpeg" } as any); // React Native
// веб: form.append("file", file); form.append("takenAt", new Date(file.lastModified).toISOString());
const res = await fetch(`${BASE}/api/uploads`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
// 201 → { "url": "/uploads/8e3a…?exp=1791828000&sig=dE5Z…", "originalName": "photo.jpg", "size": 183402, "takenAt": "2026-10-07T04:20:00.000Z" }
```

### Показ

- Все ссылки `/uploads/…` в ответах API **уже подписаны**. Используйте их как есть: `<img src={BASE + photo.fileUrl}>` или `<Image source={{ uri: BASE + photo.fileUrl }}>`. Заголовок авторизации не нужен.
- Подпись действует **7 дней** и привязана к конкретному файлу. Если картинка вернула `401`, перезапросите наряд — придут свежие ссылки.
- Без подписи сервер отдаёт файл только с заголовком `Authorization: Bearer`; без него — `401`.

### Отправка ссылок обратно

URL из ответа загрузки передавайте в `beforePhotoUrls` или `afterPhotoUrls` как есть, с подписью — сервер сам её отрежет. До 5 фото на поле.

### Проверка подлинности

Сервер проверяет фото «после»:
- точный повтор фото из другого наряда или совпадение фото «до» и «после» → доработка;
- фото снято **раньше выдачи наряда** (по времени съёмки) → доработка; снято **до начала работ** → пометка мастеру «нужна проверка»;
- похожие фото → пометка мастеру «проверьте» (см. [§10](#10-ai-проверка-как-показывать)).

Подсказывайте исполнителю снимать «до» и «после» с одной точки, но так, чтобы результат ремонта был виден.

---

## 9. Голосовой ввод

### `POST /api/ai/transcribe`

`multipart/form-data`, поле **`audio`**, до **25 МБ**. Подойдут webm, ogg/opus, m4a/aac, mp3, wav — сервер декодирует через ffmpeg. Язык — русский.

```ts
const form = new FormData();
form.append("audio", blob, "voice.webm");               // веб: MediaRecorder → Blob
const r = await fetch(`${BASE}/api/ai/transcribe`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
// 200 → { "text": "Заменить подшипник на насосе первого участка" }
```

| Ответ | Что делать |
|---|---|
| `200 { text }` | вставить текст в поле **с возможностью правки**: отраслевые термины иногда распознаются с ошибками |
| `422 Речь не распознана` | «Не расслышали, повторите» |
| `502 Whisper вернул …` | сервис распознавания недоступен — предложить ввести текстом |

Обработка занимает около 0.6 с на фразу. Короткие записи (5–20 с) работают лучше; в шумном цехе нужна гарнитура.

---

## 10. AI-проверка: как показывать

После `COMPLETE` у наряда появляется `aiAssessment`:

```json
{
  "verdict": "ACCEPTED",
  "score": 5,
  "explanation": "Описаны конкретные действия и проверка результата…",
  "strengths": ["Указан замер вибрации"],
  "improvements": [],
  "photoScore": 4,
  "photoComment": "Фото отличаются; требуется окончательная проверка мастером",
  "confidence": 0.55,
  "needsMasterReview": true,
  "masterScore": null,
  "masterComment": null,
  "reviewedById": null
}
```

| `verdict` | Показать |
|---|---|
| `ACCEPTED` | ✅ «AI: принято» |
| `ACCEPTED_WITH_COMMENTS` | ⚠️ «AI: принято с замечаниями» + список `improvements` |
| `REWORK_REQUIRED` | ❌ «AI: рекомендует доработку» + `explanation` |

- `score` — оценка 1–5, `photoScore` — оценка фото 1–5.
- **`needsMasterReview: true`** — AI не уверен (похожие фото, фото снято до начала работ, низкая уверенность vision-модели, LLM недоступна). Вердикт тогда — лишь подсказка: покажите крупную плашку «Нужна проверка мастером» и `photoComment` (например, «Фото после похоже на фото из наряда 772 — проверьте, что снимок новый»). `explanation` в этом случае начинается с «Нужна проверка мастером.».
- **Решение принимает мастер**: кнопки «Закрыть» (`CLOSE`, оценка 1–5 и комментарий) и «На доработку» (`SEND_TO_REWORK`, что исправить) доступны при любом вердикте AI.
- В рейтингах используется `masterScore`, а если его нет — `score`.
- Поле `rawResponse` служебное, показывать его не нужно.

Исполнителю после `COMPLETE` покажите вердикт и `improvements` — это подсказка, что поправить, если мастер вернёт наряд.

---

## 11. Realtime (Socket.IO)

```ts
import { io } from "socket.io-client";

const socket = io(BASE, { auth: { token }, transports: ["websocket"] });
socket.on("connect_error", (e) => { if (e.message === "unauthorized") logout(); });
socket.on("work-order:changed", (order: WorkOrder) => upsertOrder(order));
socket.on("notification:new", (n: Notification) => addNotification(n));
```

| Событие | Кто получает | Данные |
|---|---|---|
| `work-order:changed` | мастера, руководители, админы; исполнитель — **только по своим нарядам**; при переназначении — ещё и прежний исполнитель | полный наряд, как в `GET /api/work-orders/:id`, без `events`; ссылки на фото подписаны |
| `notification:new` | только адресат | объект уведомления (см. [§13](#13-уведомления-в-приложении)) |

- Исполнитель получил `work-order:changed` по наряду, где `assigneeId` уже не он (переназначили) → **уберите наряд из очереди**.
- Socket.IO переподключается сам. После переподключения перезапросите список: события за время обрыва не досылаются.
- Токен передаётся только при подключении. После повторного входа переподключитесь с новым токеном.

---

## 12. Push-уведомления (FCM)

После входа зарегистрируйте FCM-токен устройства:
```http
POST /api/devices
{ "token": "<FCM registration token, ≥ 20 символов>", "platform": "android" }   // android | ios | web
```
- Повторная регистрация того же токена безопасна: токен просто перепривязывается к текущему пользователю.
- При выходе отвяжите токен: `DELETE /api/devices/<token>` → `{ "deleted": 1 }`.

Содержимое push-сообщения:
- `notification.title`, `notification.body` — готовый текст;
- `data.type` — тип уведомления (см. [§13](#13-уведомления-в-приложении));
- `data.workOrderId` — id наряда, если есть: по тапу открывайте карточку;
- `data.priority` — для `NEW_ORDER`.

Каналы для **аварийного нового наряда** (`type=NEW_ORDER`, `priority=EMERGENCY`) и остальных уведомлений:

| | Аварийный наряд | Остальные |
|---|---|---|
| Android `channelId` | `emergency_orders` — создайте его с высокой важностью и громким звуком | `orders` |
| iOS `category` | `EMERGENCY_ORDER` | `ORDER` |

Без ключа Firebase на сервере push не отправляются, но уведомления в БД и Socket.IO работают.

---

## 13. Уведомления в приложении

- `GET /api/notifications` — последние 100 уведомлений, новые первыми.
- `PATCH /api/notifications/:id/read` → `{ "updated": 1 }`.

```json
{ "id": 2, "userId": 5, "workOrderId": 773, "type": "NEW_ORDER", "title": "Новый наряд N-21716413",
  "message": "Шум подшипника насоса", "isRead": false, "createdAt": "2026-10-05T17:35:16.450Z" }
```

| `type` | Когда |
|---|---|
| `NEW_ORDER` | назначен наряд, в том числе после переназначения |
| `DEADLINE_REMINDER` | до срока ≤ 30 мин |
| `OVERDUE_0`, `OVERDUE_1`, … | наряд просрочен; номер растёт каждые 30 мин просрочки |
| `LONG_OVERDUE_4`, … | просрочка ≥ 2 ч — руководителю |
| `NOT_ACCEPTED` | наряд не приняли (аварийный за 3 мин, обычный за 10) — мастеру. В тексте — кого предлагается назначить; в push `data.suggestedExecutorId` — его id для кнопки «Переназначить» |
| `BRIGADE_ORDER` | наряд выдан бригаде — остальным членам бригады на смене |
| `WEEKLY_AI_SUMMARY` | AI-сводка недели, по понедельникам в 08:00 |

Группируйте по префиксу: `type.startsWith("OVERDUE")` и т.п.

Текст о просрочке собран сервером целиком, как в кейсе: «Наряд №Н-00147 просрочен на 45 мин. Дробилка КМД-1750 (Д-2), участок дробление. Исполнитель: Ахметов Е. Статус: в работе с 09:20. Последний комментарий: “ждём подшипник со склада”.» Время — по часовому поясу предприятия.

---

## 14. Справочники

Доступны всем ролям. Меняются редко — кэшируйте на устройстве и обновляйте при входе.

| Запрос | Элемент |
|---|---|
| `GET /api/references/areas` | `{ id, name }` |
| `GET /api/references/equipment[?areaId=]` | `{ id, name, inventoryNumber, type, criticality, qrToken, areaId }` |
| `GET /api/references/fault-codes` | `{ id, code, name, category }` |
| `GET /api/references/materials` | `{ id, name, unit }` |
| `GET /api/references/brigades` | `{ id, name, members: [{ id, fullName, specialty }] }` |
| `GET /api/references/normatives[?equipmentId=]` | `{ id, name, equipmentType, equipmentId, faultCodeId, hours: "2", faultCode, materialNorms: [{ materialId, quantity: "1", material }] }` |
| `GET /api/references/executors[?specialty=&brigadeId=&onShift=1]` | `{ id, fullName, specialty, grade, brigadeId, brigade, employeeStatus, isOnShift, statusText, currentOrder, queue, activeOrders, _count: { assignedOrders } }` |

`employeeStatus`: `AVAILABLE` (свободен), `BUSY` (занят), `QUEUED` (есть ожидающие наряды), `OFF_SHIFT` (не на смене). Цвета панели (кейс, 5.2): `AVAILABLE` — зелёный, `BUSY` — жёлтый, `QUEUED` — синий, `OFF_SHIFT` — серый.

`statusText` — готовая подпись для выбора исполнителя: «свободен», «выполняет наряд №Н-00147, в очереди 1», «в очереди 2 наряда», «не на смене». `currentOrder` — `{ id, number, status, priority, deadline, equipment: { name } }` или `null`; `queue` — нарядов в ожидании (`ISSUED`, `QUEUED`).

---

## 15. Оборудование и QR

| Запрос | Что |
|---|---|
| `GET /api/equipment/:id/qr.png` | PNG 512×512 для печати; нужен заголовок авторизации, поэтому скачивайте через `fetch` → blob |
| `GET /api/equipment/qr/:token` | карточка по токену из QR: `{ …equipment, area: { id, name } }`; 404 — неизвестный QR |
| `GET /api/equipment/:id/history` | оборудование с `area` и `orders[]` (новые первыми): шифр, AI-оценка, простой (`downtime`), материалы. Для несуществующего id приходит `200` с телом `null`, а не 404 |

QR содержит ссылку вида `…/equipment/<qrToken>`. **Берите последний сегмент пути** — домен в ссылке может отличаться. Сценарий: исполнитель сканирует QR → `GET /api/equipment/qr/<qrToken>` → карточка, история и «Создать наряд» с уже выбранным оборудованием.

---

## 16. Рекомендации и AI-помощник

### Кого назначить — `GET /api/recommendations/executors?equipmentId=1&description=…`

Параметры: `equipmentId` (обязателен), а также подсказки о работе — `description` (текст проблемы), `faultCodeId`, `specialty`; `brigadeId` — искать только в бригаде. Только исполнители на смене; **сначала нужной специальности**, внутри — по баллу:
```json
[{ "id": 6, "fullName": "Ким Вадим Олегович", "specialty": "Слесарь", "brigadeId": 1, "employeeStatus": "AVAILABLE", "queue": 0, "equipmentRating": 4.6, "specialtyMatch": true, "requiredSpecialty": "Слесарь", "score": 86.8 }]
```
Специальность определяется так: явный `specialty` → категория шифра (`Э` — электрик, остальные — слесарь) → слова в описании («двигатель», «кабель», «пускатель» — электрик; «сварка», «трещина» — сварщик; иначе слесарь). Без подсказок специальность не учитывается и `specialtyMatch: null`. `equipmentRating` — средняя оценка работ на таком типе оборудования, `queue` — активных нарядов. Без `equipmentId` — 400, с несуществующим — 404.

### Шифр и норматив по описанию — `POST /api/recommendations/work`

```json
{ "description": "Течь сальника насоса", "equipmentId": 1 }
```
```json
{ "faultCodeId": 4, "normativeId": 4, "estimatedHours": 5, "explanation": "Течь сальника обычно связана с износом набивки…" }
```
`faultCodeId` и `normativeId` могут быть `null`. Показывайте их как **подсказку** с кнопкой «Применить», а не подставляйте молча. Ответ приходит за 2–10 с.

### AI-помощник — `POST /api/assistant/chat`

```json
{ "message": "Кто свободен из электриков?" }
```
```json
{
  "answer": "Свободен Исполнитель 1 (электрик, 4 разряд).",
  "intent": { "intent": "FREE_EXECUTORS", "specialty": "Электрик" },
  "data": [{ "id": 4, "fullName": "Исполнитель 1", "specialty": "Электрик", "grade": 4 }]
}
```
- `message` — от 2 до 1000 символов.
- Ответ приходит за 2–10 с — покажите индикатор «печатает…».
- `answer` выведите текстом. По `intent.intent` можно дорисовать данные из `data`:

| `intent.intent` | `data` | Как показать |
|---|---|---|
| `FREE_EXECUTORS` | `[{ id, fullName, specialty, grade }]` | список людей с кнопкой «Назначить» |
| `OVERDUE` | наряды с `equipment`, `assignee` | список нарядов |
| `EQUIPMENT_HISTORY` | наряды с `faultCode`, `aiAssessment` | история |
| `SHIFT_REPORT` | отчёт за смену/период ([§17](#17-аналитика-отчёты-выгрузки)) без `load`, плюс `area`, `periodDays`, `busiestExecutors` | цифры и сводка |
| `ANOMALIES` | аномалии ([§17](#17-аналитика-отчёты-выгрузки)) | карточки аномалий |
| `FAILURE_FORECAST` | прогноз | список с вероятностью |

История диалога: `GET /api/assistant/history` — 100 сообщений, новые первыми; поле `role` принимает значения `user` или `assistant`.

Участок и период помощник понимает из вопроса: «Сформируй отчёт за неделю по участку обогащения», «Покажи проблемы участка дробления за месяц». Тогда в `intent` есть `periodDays` (смена 0.5, сутки 1, неделя 7, месяц 30, квартал 90), `areaId` и `area`; данные отфильтрованы по участку (отчёт, просрочки, аномалии, прогноз).

Подсказки-кнопки: «Кто свободен?», «Что просрочено?», «Как прошла смена?», «Отчёт за неделю по участку…», «Покажи аномалии», «Прогноз отказов». Можно спрашивать и по-казахски.

---

## 17. Аналитика, отчёты, выгрузки

Доступны мастеру, руководителю и админу.

**Фильтры** одинаковы для всех отчётов `reports/*` и выгрузок (кейс, раздел 7):

| Параметр | Значение |
|---|---|
| `period` | `shift` (12 ч), `day`, `week`, `month` (30 дней) |
| `from`, `to` | произвольный период (ISO-даты); `from` важнее `period` |
| `areaId`, `equipmentId`, `executorId`, `brigadeId` | фильтры |

По умолчанию: отчёт за смену — 12 ч, остальные — 30 дней. Отчёт за смену, материалы, простои и выгрузка нарядов считают по дате создания наряда, рейтинги — по дате закрытия.

| Запрос | Ответ |
|---|---|
| `GET /api/analytics/dashboard` | `{ active, overdue, equipmentInDowntime, averageReactionMinutes, averageCompletionMinutes, topEquipment: [{ equipmentId, name, _count }], topAreas: [{ areaId, name, units, emergencies, emergenciesPerUnit, downtime, downtimePerUnit, orders }], topExecutors: [{ id, fullName, score, closed }] }` |
| `GET /api/analytics/failure-forecast?days=30` | `[{ equipmentId, equipment, recentFailures, previousFailures, growth, probability }]`; `probability` 0.05–0.95 → показывать в % |
| `GET /api/analytics/anomalies[?areaId=&type=]` | `[{ id, type, title, description, recommendation, severity 1–5, evidence, area, equipment, periodFrom, periodTo }]`; с `areaId` — аномалии участка и общие (`areaId: null`) |
| `POST /api/analytics/anomalies/run` `{ from?, to?, areaId? }` | `{ insights: [...], ai: { summary, recommendations[] } }` — пересчёт, 5–20 с |
| `GET /api/reports/shift` | `{ from, to, issued, completed, closed, overdue, rejected, cancelled, inProgress, load: [{ id, fullName, specialty, employeeStatus, isOnShift, assigned, completed, activeNow }], workload: { executorsOnShift, busy, free }, downtime: { equipmentInDowntimeNow, orders, minutes }, aiSummary }` |
| `GET /api/reports/ratings` | `[{ id, fullName, specialty, brigadeId, score 0–100, quality, onTimeRate, reworkRate, repeatFailureRate, returnRate, productivity, unjustifiedRejects, complexityBonus, closed, points: { quality, onTime, noReturns, volume, complexity, rejects }, explanation, formula }]` |
| `GET /api/reports/my-rating` | то же для текущего исполнителя (любая роль может вызвать, но не-исполнителю — 404) |
| `GET /api/reports/brigade-ratings` | `[{ id, name, members, closed, quality, onTimeRate, repeatFailureRate, score }]` |
| `GET /api/reports/materials[?groupBy=material\|area\|equipment\|executor]` | `[{ group: { id, name } \| null, materialId, material, unit, quantity, count, normQuantity, deviationPercent, overNormCount, overNormOrders[], _sum, _count }]` |
| `GET /api/reports/downtime` | `{ from, to, totals: { minutes, plannedMinutes, unplannedMinutes, plannedShare, unplannedShare, ongoing }, byEquipment: [{ equipmentId, equipment, area, minutes, count, plannedMinutes, unplannedMinutes, plannedShare, unplannedShare, ongoing, byFaultCode: [{ code, name, minutes, count }] }], items: [{ workOrderId, number, type, equipment, area, faultCode, reason, startedAt, endedAt, ongoing, minutes }] }` |
| `GET /api/reports/work-order/:id` | полный отчёт мастеру, как `GET /api/work-orders/:id/report`; несуществующий id → 404 |
| `GET /api/reports/work-order/:id.pdf` | тот же отчёт в PDF |

**Рейтинг исполнителя** — прозрачная формула, `points` — сколько баллов дала каждая часть, `explanation` — готовый текст для исполнителя: «Качество 4.5 из 5 → 40.5 из 45; в срок 80% → 20 из 25; без доработок и повторных поломок 90% → 13.5 из 15; … Итого 79 из 100. Больше всего баллов можно добавить, если закрывать наряды в срок…». Возвратом считается наряд, который мастер вернул на доработку **или** после которого та же неисправность на том же оборудовании повторилась в течение 7 дней.

Пример `GET /api/analytics/dashboard`:
```json
{
  "active": 18, "overdue": 3, "equipmentInDowntime": 2,
  "averageReactionMinutes": 7, "averageCompletionMinutes": 142,
  "topEquipment": [{ "equipmentId": 3, "_count": 6, "name": "Конвейер К-3" }],
  "topExecutors": [{ "id": 7, "fullName": "Исполнитель 3", "score": 4.8, "closed": 12 }]
}
```
- `active` — наряды в `ISSUED`, `ACCEPTED`, `QUEUED`, `IN_PROGRESS`, `PAUSED`, `REWORK`; `overdue` — из них просроченные.
- `averageReactionMinutes` — от создания до принятия, `averageCompletionMinutes` — от начала до завершения; оба по закрытым за 30 дней.
- `topEquipment` — топ-5 по аварийным нарядам за 30 дней; `topAreas` — участки, отсортированные по авариям на единицу оборудования за 30 дней; `topExecutors` — топ-5 по средней оценке 1–5 за 30 дней.

Пример аномалии:
```json
{ "id": 1, "type": "REPEATED_FAULT", "title": "Конвейер К-3: повторяющийся шифр M-04",
  "description": "Одинаковая неисправность зарегистрирована 5 раз (62% ремонтов)",
  "recommendation": "Проверить первопричину вместо повторной замены узла", "severity": 4,
  "areaId": 1, "equipmentId": 3, "periodFrom": "…", "periodTo": "…",
  "evidence": { "faultCode": "M-04", "count": 5, "share": 0.62 }, "createdAt": "…",
  "area": { "id": 1, "name": "…" }, "equipment": { "id": 3, "name": "Конвейер К-3", "…": "…" } }
```
В ответе `POST /anomalies/run` элементы `insights` приходят **без** `area` и `equipment`.

Аномалии `type`:

| `type` | Что найдено | Привязка |
|---|---|---|
| `FREQUENT_FAILURES` | частые отказы оборудования | `equipmentId` |
| `REPEATED_FAULT` | один шифр повторяется на оборудовании | `equipmentId` |
| `FAILURE_AFTER_PLANNED_MAINTENANCE` | отказы вскоре после ППР | `equipmentId` |
| `MATERIAL_ANOMALY` | расход сверх нормы | `equipmentId` |
| `AREA_HOTSPOT` | участок с наибольшим числом аварий или простоем на единицу оборудования | `areaId` |
| `SHIFT_PATTERN` | аварии сосредоточены в одной смене | общая |
| `TIME_OF_DAY` | пик аварий в один интервал суток | общая |
| `EXECUTOR_REPEAT_FAILURES` | после ремонтов исполнителя та же неисправность возвращается в течение 7 дней; `evidence.executorId` | общая |
| `BRIGADE_REPEAT_FAILURES` | то же по бригаде; `evidence.brigadeId` | общая |

**Выгрузки** отдаются как файлы и требуют заголовок авторизации:
```ts
const r = await fetch(`${BASE}/api/reports/export.xlsx?from=2026-10-01T00:00:00Z`, { headers: { authorization: `Bearer ${token}` } });
const blob = await r.blob();
const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "naryad-report.xlsx" });
a.click();
```
- параметр **`report`** выбирает отчёт: `orders` (по умолчанию — список нарядов), `shift`, `ratings`, `brigades`, `materials` (с `groupBy`), `downtime`, `anomalies`; фильтры — как выше;
- `export.xlsx?report=shift` — лист с таблицей и лист «Итоги» со сводкой;
- `export.pdf` без периода для `orders` — за текущую смену (12 ч), остальные отчёты — 30 дней.

---

## 18. Администрирование

Только `ADMIN`:

| Запрос | Тело |
|---|---|
| `GET /api/admin/users` | — (без хеша пароля, с `phone` и `brigade`) |
| `POST /api/admin/users` | `{ phone, password (6–128), fullName (≥3), role, specialty?, grade?, brigadeId?, language?: "ru" \| "kk", login? }` — `login` по умолчанию равен телефону |
| `PATCH /api/admin/users/:id` | любые из `{ phone, password, fullName, role, specialty, grade, brigadeId (можно null), language }` — правка сотрудника и **сброс пароля** |
| `PATCH /api/admin/users/:id/shift` | `{ isOnShift: boolean, employeeStatus: "AVAILABLE" \| "BUSY" \| "QUEUED" \| "OFF_SHIFT" }` |
| `POST /api/admin/areas`, `PATCH /api/admin/areas/:id` | `{ name (≥2) }` |
| `POST /api/admin/equipment` | `{ name, inventoryNumber, type, criticality 1–5, areaId }` — все обязательны |
| `PATCH /api/admin/equipment/:id` | те же поля, все необязательны |
| `POST /api/admin/fault-codes` | `{ code, name, category }` |
| `POST /api/admin/materials` | `{ name, unit }` |
| `POST /api/admin/brigades` | `{ name }` |
| `POST /api/admin/normatives` | `{ name, equipmentType?, equipmentId?, faultCodeId?, hours, materials: [{ materialId, quantity }] }` |
| `DELETE /api/admin/{areas,equipment,fault-codes,materials,brigades,normatives}/:id` | `204`; `409`, если запись используется; `404`, если её нет |

- Ответы `POST` — созданная запись со статусом `201`; `PATCH` — обновлённая запись. Пользователь приходит без хеша пароля.
- Дубль уникального поля (телефон, логин, инвентарный номер, код шифра, название участка/материала/бригады) → `409 Такая запись уже существует`.
- Удаления пользователей и правки шифров, материалов, бригад и нормативов в API нет — только создание (и удаление для справочников).
- `PATCH /users/:id/shift` выставляет `employeeStatus` вручную, но сервер пересчитает его при следующем действии с нарядами этого исполнителя. Обычно достаточно менять `isOnShift`, а статус передавать `AVAILABLE` (на смене) или `OFF_SHIFT`.
- Сотрудники, пришедшие из 1С, получают случайный пароль, а телефон — только если 1С его передала. Чтобы такой сотрудник мог войти, админ задаёт ему `phone` (если нет) и `password` через `PATCH /api/admin/users/:id`. Пользователь без телефона войти не может.

### Панель интеграции с 1С (админ, руководитель)

| Запрос | Ответ |
|---|---|
| `GET /api/integrations/1c/jobs?status=FAILED,DEAD&limit=100` | задания обмена, новые первыми; `limit` до 500 |
| `POST /api/integrations/1c/jobs/:id/retry` | задание снова в `PENDING`, счётчик попыток обнулён |
| `POST /api/integrations/1c/run` | `{ processed, succeeded, disabled }` — отправить очередь сейчас; `disabled: true`, если интеграция выключена |
| `GET /api/integrations/1c/mappings?entity=EQUIPMENT` | `[{ id, entity, localId, externalId, createdAt, updatedAt }]` |
| `POST /api/integrations/1c/push/orders` `{ ids?: number[], since?: ISO }` | `202 { queued, jobIds }` — принудительно выгрузить наряды (до 500) |
| `GET /api/integrations/orders?since=ISO` | до 5000 нарядов, изменённых после `since`, для сверки |

Задание:
```json
{ "id": 51, "direction": "OUTBOUND", "entity": "WORK_ORDER", "eventType": "COMPLETE", "localId": 42,
  "externalId": null, "idempotencyKey": "naryad:out:42:COMPLETE:…", "payload": { "…": "снимок наряда" },
  "status": "FAILED", "attempts": 3, "nextAttemptAt": "…", "lastAttemptAt": "…", "completedAt": null,
  "lastError": "1С HTTP 500: …", "response": null, "createdAt": "…", "updatedAt": "…" }
```
| `status` | Показать |
|---|---|
| `PENDING` | в очереди |
| `PROCESSING` | отправляется |
| `SUCCESS` | доставлено |
| `FAILED` | ошибка, будет повтор в `nextAttemptAt` (через 2, 4, 8, 16, 32, 60 мин) |
| `DEAD` | попытки исчерпаны — нужна кнопка «Повторить» (`retry`) |

`direction: "INBOUND"` — входящие пакеты из 1С. Кнопку «Повторить» для них не показывайте: сервер отправляет только исходящие, входящий пакет повторяет 1С с тем же `requestId`.

---

## 19. Ошибки

Формат всегда один:
```json
{ "error": "Текст для пользователя", "details": "…только для 400: ошибки полей…" }
```

| Код | Значение | Реакция клиента |
|---|---|---|
| 400 | неверные данные; `details` — JSON-строка с ошибками по полям (`path`, `message`) | подсветить поля |
| 401 | нет или истёк токен; неверный телефон или пароль; файл без подписи | на экран входа (кроме экрана входа и картинок) |
| 403 | роль не позволяет; чужой наряд | скрыть действие |
| 404 | не найдено | убрать из списка |
| 409 | статус уже изменился; запись используется; дубликат | обновить данные и показать `error` |
| 422 | речь не распознана; ошибка импорта | попросить повторить |
| 429 | вход заблокирован; `Retry-After` в секундах | таймер на кнопке входа |
| 500 | внутренняя ошибка | «Что-то пошло не так», повторить позже |
| 502 | сервис распознавания речи недоступен | предложить ввод текстом |

---

## 20. Готовый API-клиент

```ts
export const BASE = "http://<сервер>:8765";

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: string, public retryAfter?: number) { super(message); }
}

let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, timeoutMs = 30_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(BASE + path, {
    ...rest, headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const body = await res.json().catch(() => ({ error: res.statusText }));
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  if (res.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized();
  throw new ApiError(res.status, body.error ?? "Ошибка", body.details, retryAfter);
}

declare function onUnauthorized(): void; // ваш переход на экран входа

// Примеры
export const login = (phone: string, password: string) => api<LoginResponse>("/api/auth/login", { method: "POST", json: { phone, password } });
export const myQueue = () => api<WorkOrder[]>("/api/work-orders?compact=1&status=ISSUED,QUEUED,ACCEPTED,IN_PROGRESS,PAUSED,REWORK");
export const act = (id: number, body: ActionRequest) =>
  api<ActionResponse>(`/api/work-orders/${id}/action`, { method: "POST", json: body, timeoutMs: body.action === "COMPLETE" ? 250_000 : 30_000 });
```

Типы `LoginResponse`, `WorkOrder`, `ActionRequest`, `ActionResponse` и остальные — в [frontend-types.ts](frontend-types.ts).

---

## 21. Чек-лист интеграции

- [ ] Вход: обработаны 401, 429 + `Retry-After`; токен в защищённом хранилище; при 401 — на экран входа.
- [ ] Очередь исполнителя: `compact=1`, сортировка сервера, подсветка просроченных.
- [ ] Кнопки действий по `availableActions()`; поля причины для `REJECT` и `PAUSE`.
- [ ] `COMPLETE`: обязательные текст и шифр, фото для аварийных; экран ожидания AI; таймаут ≥ 250 с.
- [ ] Офлайн: `clientActionId` на каждое действие; `replayed: true` = успех; 409 = снять из очереди и обновить.
- [ ] Фото: загрузка до `COMPLETE`, ссылки как есть, при 401 картинки — перезапрос наряда; `takenAt` из `file.lastModified`, если снимок без EXIF.
- [ ] Карточка исполнителя: комментарий без смены статуса (`/comment`), «Моя оценка» из `/:id/report`, «Мой рейтинг» с `explanation`.
- [ ] Панель мастера: `/work-orders/board` (колонки + счётчики), цвета статусов исполнителей, `statusText` при выборе исполнителя, подбор с `description`.
- [ ] AI-проверка: плашка «Нужна проверка мастером» при `needsMasterReview`; по `NOT_ACCEPTED` — кнопка «Переназначить» на `data.suggestedExecutorId`.
- [ ] Голос: поле `audio`, редактируемый результат, обработка 422 и 502.
- [ ] Socket.IO: подключение с токеном, `upsert` по `work-order:changed`, удаление переназначенного, перезапрос после reconnect.
- [ ] FCM: регистрация после входа, удаление при выходе, канал `emergency_orders`, открытие наряда по `data.workOrderId`.
- [ ] Числа-строки (`hours`, `quantity`) приводятся через `Number()`.
- [ ] Язык интерфейса — по `user.language`.
