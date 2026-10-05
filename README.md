# НарядAI Backend

Backend полного прототипа кейса «НарядAI»: TypeScript, Express, Prisma, MySQL, Socket.IO, Ollama `gpt-oss:20b`, Whisper и Firebase Cloud Messaging.

## Реализовано

- роли: мастер, исполнитель, руководитель, администратор;
- вход по логину/ПИН и JWT;
- справочники участков, оборудования, сотрудников, бригад, шифров, материалов и нормативов;
- полный жизненный цикл наряда и журнал событий;
- создание, переназначение, отмена и изменение приоритета;
- статусы людей и нарядов через Socket.IO;
- очередь исполнителя, причины отказа и приостановки;
- фото до/после, сжатие, проверка повторного фото и базовое визуальное сравнение;
- списание материалов и сравнение с нормативом;
- контроль срока, повторные напоминания и эскалации;
- уведомления в БД, Socket.IO и FCM;
- AI-проверка закрытия через Ollama, оценка и решение мастера;
- рекомендации исполнителя, шифра неисправности и норматива;
- Whisper-распознавание русского голоса;
- отчёты, рейтинги, PDF и Excel;
- поиск повторных поломок, отказов после ППР и аномального расхода;
- прогноз отказов, дашборд и еженедельная AI-сводка;
- безопасный AI-помощник мастера без произвольного SQL;
- QR-код оборудования;
- идемпотентные действия для офлайн-очереди мобильного клиента;
- JSON-выгрузка для будущей интеграции с 1С/ERP/ТОиР;
- 500 исторических нарядов с заложенными закономерностями.

## Документация

- [docs/FEATURES.md](docs/FEATURES.md) — полное описание функционала, правил, формул и API.
- [docs/TESTING_AND_RESEARCH.md](docs/TESTING_AND_RESEARCH.md) — автотесты (273, покрытие 97.9%), исследования качества AI, нагрузочные тесты, найденные дефекты, графики.

## Развёртывание на сервере

`docker-compose.server.yml` поднимает MySQL (`127.0.0.1:3407`) и API (`:8765`, host network) и использует уже работающие на сервере Ollama (`:11434`) и `whisper-service` (`:8090/transcribe`). Секреты — в `.env`.

```bash
docker compose -f docker-compose.server.yml up -d --build
```

## Быстрый запуск

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec api npm run db:seed
```

Compose запускает MySQL, API и Ollama, затем загружает `gpt-oss:20b`. Первый запуск модели может занять продолжительное время.

Whisper запускается отдельно и должен предоставлять OpenAI-совместимый `POST /v1/audio/transcriptions`. Адрес задаётся через `WHISPER_URL`. На macOS backend в Docker по умолчанию обращается к `host.docker.internal:8000`.

Проверка: `curl http://localhost:8765/health`.

Тестовые пользователи: `admin`, `master`, `manager`, `worker1` ... `worker15`. ПИН: `1234` или значение `SEED_PIN`. На сервере ПИН заменены случайными, см. `demo-credentials.local.txt`.

## Локальный запуск

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run db:seed
npm run dev
```

## AI

- `OLLAMA_MODEL=gpt-oss:20b` используется для текста, отчётов, подсказок, аналитики и помощника.
- `OLLAMA_VISION_MODEL` необязателен. С ним фото дополнительно проверяются мультимодальной моделью Ollama.
- Без vision-модели backend проверяет наличие, метаданные, повторы и визуальную схожесть фото.
- При низкой уверенности решение всегда передаётся мастеру.
- При `AI_STRICT=false` обязательные проверки работают даже при временной недоступности Ollama.

## Основные API

Авторизация и устройства:

- `POST /api/auth/login`, `GET /api/auth/me`
- `POST /api/devices`, `DELETE /api/devices/:token`

Наряды:

- `GET|POST /api/work-orders`
- `GET|PATCH /api/work-orders/:id`
- `POST /api/work-orders/:id/action`
- `POST /api/work-orders/:id/reassign`

Для офлайн-повторов передавайте уникальный `clientActionId`. Повтор не изменит данные второй раз.

Справочники и оборудование:

- `GET /api/references/areas|equipment|executors|fault-codes|materials|brigades|normatives`
- `POST|PATCH /api/admin/...`
- `GET /api/equipment/:id/history`
- `GET /api/equipment/:id/qr.png`
- `GET /api/equipment/qr/:token`

AI и голос:

- `POST /api/ai/transcribe` — multipart, поле `audio`
- `GET /api/recommendations/executors?equipmentId=...`
- `POST /api/recommendations/work`
- `POST /api/assistant/chat`, `GET /api/assistant/history`

Примеры: «Кто свободен из электриков?», «Что просрочено?», «Покажи аномалии», «Дай прогноз отказов».

Аналитика и отчёты:

- `GET /api/analytics/dashboard`
- `POST /api/analytics/anomalies/run`
- `GET /api/analytics/anomalies|failure-forecast`
- `GET /api/reports/shift|ratings|brigade-ratings|materials|downtime`
- `GET /api/reports/work-order/:id`
- `GET /api/reports/export.pdf|export.xlsx`
- `GET /api/integrations/orders?since=...`

Отчёты принимают `from`, `to`, `areaId`, `equipmentId`, `executorId` и `brigadeId`.

## Socket.IO

```ts
io("http://localhost:8765", { auth: { token } });
```

События: `work-order:changed`, `notification:new`.

## Проверка проекта

```bash
npm run build
npm test                 # нужна БД naryad_test, см. docs/TESTING_AND_RESEARCH.md
npm run test:coverage
docker compose config
```

## Граница backend

Крупные кнопки, мобильная офлайн-БД, Android/iOS/PWA, казахские тексты интерфейса и ограничение создания шестью нажатиями относятся к клиенту. Backend предоставляет роли, идемпотентность, realtime, язык пользователя и необходимые API.
