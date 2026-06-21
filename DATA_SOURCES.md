# Rich data for WC2026 — what's gettable (passes, coords, xG, danger, tracking)

Post-match generation (latency irrelevant) → richness is the goal. Priorities:
1) все пасы с x,y + направление; 2) удары с xG + координаты; 3) опасные моменты/
последовательности; 4) движение игроков (трекинг); 5) полная таксономия событий.

## TL;DR
- **Удары + xG + координаты для WC2026 — БЕСПЛАТНО и СЕЙЧАС** (Sofascore / FotMob shotmap). Доступ за Cloudflare/токеном → нужен браузерный фетч.
- **Все пасы с координатами для WC2026 — бесплатно напрямую НЕТ.** Сейчас только скрейп WhoScored (Opta-поток, gray-area). После финала — StatsBomb Open Data (чисто, но лицензия под арт неясна).
- **Настоящий трекинг «22 точки» для WC2026 — бесплатно нет вообще.** Только платно/enterprise. Прокси сейчас — хитмапы/средние позиции (Sofascore).
- **Дешёвый платный self-serve (Sportmonks €129/мес) координат пасов НЕ даёт** (только xG-агрегат + momentum). Реальные координаты пасов = Wyscout ~£5k/год или StatsBomb (quote).
- **Строить «танец пасов» уже сегодня:** прототип на FREE StatsBomb WC2022 open (реальные координаты) / PFF FC WC2022 (трекинг) / Wyscout-Pappalardo WC2018 (CC BY 4.0).

---

## БЕСПЛАТНО, доступно СЕЙЧАС для WC2026 (post-match)

### Sofascore (unofficial) — лучший низкофрикционный для shot-coords + momentum
- Проверено агентом live: `api.sofascore.com/api/v1/event/{id}/shotmap` → массив ударов с `playerCoordinates {x,y,z}`, `goalMouthCoordinates`, `blockCoordinates`, `xg`, `xgot`, `bodyPart`, `situation`, `goalMouthLocation`, `shotType`.
- `…/event/{id}/graph` → **Attack Momentum** (временной ряд опасности) — прокси «опасные моменты».
- `…/event/{id}/average-positions` (`averageX/averageY` на игрока), `…/player/{pid}/heatmap` — **прокси движения/territory** (не настоящий трекинг).
- `…/event/{id}/incidents` — голы/карточки/замены/VAR.
- ⚠️ **Cloudflare**: голый curl → 403 (проверено). Нужен cloudscraper / браузерные заголовки / Playwright+системный Chrome (есть на машине, см. [[tooling_video_capture]]). Обёртка: ScraperFC.
- **НЕТ** полного потока пасов с координатами.

### FotMob (unofficial) — то же по богатству (Opta), но токен
- `fotmob.com/api/matchDetails?matchId={id}` → `content.shotmap.shots[]` с `x,y`, `expectedGoals`, `expectedGoalsOnTarget`, `situation`, `shotType`, `isBlocked`, `blockedX/Y`, `goalCrossedY/Z` + momentum + Top stats. WC2026 live (Opta, league 77).
- ⚠️ Нужен подписанный заголовок `x-fm-req`/`x-mas` (base64 JSON + MD5(body+secret)). Обход: реплицировать заголовок / headless-браузер (LanusStats `nodriver`) / реплей токена из своего браузера.
- **НЕТ** пасов с координатами.

### ESPN (что уже используем) — потолок: БЕЗ координат
- `summary?event={id}` → boxscore, lineups, win-prob, odds, **текстовый** keyEvents/commentary (минута+текст). Никаких x,y, shotmap, xG-с-координатами. Это предел ESPN.

### FBref (StatsBomb-powered) — WC2026 есть, координат НОЛЬ
- `fbref.com/en/comps/1/...` — матч-репорты по ходу турнира. Per-shot **xG, PSxG, дистанция (скаляр), часть тела** — но дистанция ≠ координата. Пасы — только агрегаты (progressive, key, xA).
- Лимит 10 req/min (иначе ~1ч бан). R-пакет worldfootballR (FotMob-поддержку выпилили в 0.6.4).

### Understat — для WC НЕ годится
- Только 6 клубных лиг, никаких сборных/ЧМ.

---

## Все пасы с координатами для WC2026

### Сейчас (free, gray-area): скрейп WhoScored (Opta)
- Match-centre страницы WC2026 уже есть; в исходнике `matchCentreData` JSON с `x,y,endX,endY` (поле 0–100) для **пасов, ударов, carries, tackles, dribbles, duels** — полный Opta on-ball поток.
- ⚠️ За **Imperva Incapsula** + JS-рендер → undetected-chromedriver/nodriver, медленный темп. Это **Opta IP**, ToS запрещает скрейп/распространение → держать приватно/некоммерчески, сырьё не публиковать. Тулзы: soccerdata, Ali-Hasan-Khan/Scrape-Whoscored-Event-Data.

### После финала (~конец июля–август 2026): StatsBomb Open Data — лучший чистый путь
- История релизов ЧМ: WC2018 +2мес, WC2022 +1мес, WWC2023 +3дня (лаг сокращается) → WC2026 правдоподобно через дни–недели после финала 19.07.2026. **Не гарантировано, в ходе турнира НЕ будет.**
- Поле 120×80; `location[x,y]`, `pass.end_location[x,y]`, `carry.end_location`, `shot.end_location[x,y,z]`, `shot.statsbomb_xg`. Полная таксономия + **Pressure** + GK + **360 freeze-frames** (per-event снимок видимых игроков, НЕ непрерывный трекинг).
- ⚠️ Лицензия «research / genuine interest»; продаваемый/выставочный арт явно не разрешён → OCR LICENSE.pdf + письменный запрос StatsBomb.

---

## Трекинг (движение всех 22 игроков) — для WC2026 бесплатно НЕТ
- Только платно/enterprise: SkillCorner (broadcast-трекинг, ~10fps, off-screen экстраполяция), PFF FC, TRACAB/Second Spectrum. WC2026 не подтверждён, broadcast-IP сильно защищён.
- **Прокси сейчас:** Sofascore average-positions + per-player heatmaps (позиционно, не непрерывно).
- **Бесплатные сэмплы (НЕ ЧМ, для прототипа):** SkillCorner opendata (~10 матчей A-League, MIT), Metrica sample (3 матча), PFF FC WC2022 (трекинг всех 64 матчей, бесплатно!).

---

## ПЛАТНО (если дойдёт до серьёза/комишна)

| Провайдер | Пасы x,y | xG | Трекинг | WC2026 | Купит физлицо | Цена | Под что |
|---|---|---|---|---|---|---|---|
| **Sportmonks** | **НЕТ** | да (агрегат, без коорд. ударов) | нет | да ✓ | да, self-serve | €69/€129 мес | дёшево: xG+momentum, НЕ координаты |
| **Wyscout Data API** | **да** | да | нет | вероятно (уточнить) | данные — нет (quote) | ~£5k/лига/год | дешевейший путь к настоящим коорд. пасов |
| **StatsBomb** | **да** (глубже всех) | да + OBV | только 360 | да (платно) | нет self-serve | нет публичной; ~низкие 5 знаков | богатейшая таксономия |
| **Opta/Stats Perform** | **да** | да | доп. | да (офиц., betting-scoped) | вряд ли | дороже всех | официальные данные ЧМ |
| **SkillCorner** | — (трекинг) | дерив. | **да (22)** | возможно, не подтв. | нет | quote | движение игроков |
| **PFF FC** | да (платно) | да | **да** | WC2022 free; WC2026 TBD | WC2022 free; платно B2B | free(2022)/quote | лучший FREE коорд+трекинг (только 2022) |
| **API-Football** | НЕТ | частично | нет | да | да, дёшево | $19–39 мес | счёт/составы, без координат |

⚠️ У ВСЕХ платных стандартная лицензия ограничивает публичный показ/распространение, + поверх FIFA-режим прав на WC2026 → для выставки/продажи нужна письменная очистка прав.

---

## Прототип-заглушка с РЕАЛЬНЫМИ координатами (чтобы строить «танец пасов» сегодня)
- **StatsBomb WC2022 open** (полные координаты пасов + xG + 360) + **PFF FC WC2022** (трекинг 22) — та же схема, что будет в 2026.
- **Wyscout/Pappalardo WC2018** — CC BY 4.0 (коммерция ок), 64 матча, события с x,y (0–100). Чистейшая лицензия.

## Рекомендация (двухслойно)
1. **Сейчас, легально, низкий риск** — обогатить Монумент Sofascore/FotMob: shot-map (позиционированные xG-блумы) + momentum (опасность) + средние позиции/хитмапы (движение/territory). Большой скачок плотности и многослойности без юр-риска. Доступ — Playwright+Chrome / cloudscraper.
2. **«Танец всех пасов с координатами»** — прототипировать дизайн на StatsBomb WC2022 open уже сегодня; для самого WC2026 решить позже: (а) приватный скрейп WhoScored, (б) ждать StatsBomb open после финала, (в) платить (Wyscout/StatsBomb) если будет комишн/выставка.
