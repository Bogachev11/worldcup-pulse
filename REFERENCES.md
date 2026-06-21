# World Cup Pulse — Reference Library

Кураторская подборка референсов: проекты, которые превращают спортивные/живые
данные в искусство, плюс визуальные техники и инструменты. Каждый пункт — рабочая
ссылка + что именно брать.

---

## 1. Спорт + генеративное/дата-искусство (прямые попадания)

### Karim Douïeb — «All the Passes» ⭐ ближайший референс к идее
~882 000 пасов из 890 матчей (Лига чемпионов, ЧМ-2018, Ла Лига, NWSL, АПЛ)
анимированы как единый светящийся рой, складывающийся в органическое flow-поле —
«форма самого футбола». Three.js / WebGL на Observable.
- https://observablehq.com/@karimdouieb/all-the-passes
- Разбор: https://observablehq.com/blog/anatomy-of-an-impactful-data-visualization-with-karim-douieb

### Karim Douïeb — «Football Wind»
Пасы как метеорологическое поле ветра: направления превращаются в потоковые
течения частиц над полем.
- https://observablehq.com/@karimdouieb/football-wind

### Karim Douïeb — «Football Control Space»
Контроль территории в стиле Вороного: цветные регионы делят поле, показывая, кто
владеет пространством. D3.js.
- https://observablehq.com/@karimdouieb/football-control-space
- Хаб всех работ: https://observablehq.com/@karimdouieb

### Variable.io — «IBM Technology Garden / Match Flower» ⭐ «матч как организм»
Live-инсталляция 4K: матч (Уимблдон) растёт как ботанический организм через
морфогенез — сеты = группы веток, геймы = ветки, выигранные очки = распускающиеся
цветы. Бронза Information is Beautiful Awards 2019.
- https://variable.io/ibm-technology-garden/
- Студия: https://variable.io/studio/

### Zeh Fernandes — «GenCup»
Каждый матч ЧМ → уникальный абстрактный генеративный постер; данные 22 игроков
управляют формами/цветами. Издания 2018–2026.
- https://www.gencup.art/
- Сет 2022 (64 постера): https://www.gencup.art/2022

### Ben Fry / Fathom — «Salary vs. Performance»
Канон «спортивные данные как изящный объект»: 30 команд MLB, зарплаты ↔ результаты,
линиями, прокручивается по сезону. Processing → JS/Canvas.
- https://www.benfry.com/salaryper/

### Контекст футбольной дата-визуализации
- Barça Innovation Hub, «capturing chaos» (футбол как букет): https://barcainnovationhub.fcbarcelona.com/football-visualisation-capturing-chaos-and-cultivating-context/
- FIELD.io — Nike Generative Surface (генеративная сетка, не дата-арт): https://field.io/work/nike-generative-surface
- onformative — «Meandering River» (поток+организм+генеративный звук): https://onformative.com/work/meandering-river/

> Важная находка: xG-**аналитики** море, а xG-**арта** почти нет. Свободная ниша.

---

## 2. Футбольная дата-виз, которая «как искусство»

### Karun Singh — «Expected Threat (xT)»
Оригинальная статья с интерактивной 3D-«поверхностью ценности» над полем: опасность
как топография, растущая к воротам.
- https://karun.in/blog/expected-threat.html

### John Burn-Murdoch (FT) — футбольная графика
Эталон стиля: сдержанная палитра, лососёвый фон, безупречная типографика,
аннотация-как-нарратив. D3.js / R-ggplot2.
- http://johnburnmurdoch.github.io/reveal/football-data.html
- Метод: https://gijn.org/stories/data-visualization-storytelling-tips-john-burn-murdoch/

### Live-momentum как визуальный язык
- Bundesliga Match Momentum (Sportec/AWS) — текучий area-stream доминирования: https://aws.amazon.com/blogs/media/bundesliga-match-fact-match-momentum-revealing-the-games-invisible-pulse
- Sofascore Attack Momentum (красно-синяя лента) — Opta-powered, есть на ЧМ: https://www.sofascore.com/news/how-live-attack-momentum-works-at-the-world-cup
- Footovision Dynamic Pitch Control (дышащие регионы влияния): https://www.footovision.com/visualizing-positioning-and-player-decisions-the-innovation-of-dynamic-pitch-control

### Шаблоны эстетики
- StatsBomb radars («отпечаток» игрока): https://blogarchive.statsbomb.com/articles/soccer/understand-football-radars-for-mugs-and-muggles/
- mplsoccer (pizza/shot maps): https://mplsoccer.readthedocs.io/
- Soccermatics (pass networks + pitch control): https://soccermatics.readthedocs.io/en/latest/lesson6/PitchControl.html

---

## 3. Генеративные / live-data инсталляции (техника + эстетика)

### Сине-чип артисты
- Memo Akten — «Forms» (движение олимпийцев → абстрактные 3D-скульптуры; Golden Nica 2013) ⭐ спорт→абстракция: https://www.memo.tv/works/forms/
- Memo Akten — «Simple Harmonic Motion» (муар/полиритмы из простых агентов): https://www.memo.tv/works/simple-harmonic-motion/
- Memo Akten — «Learning to See» (live-камера → GAN переосмысляет в океаны/огонь): https://www.memo.tv/works/learning-to-see/
- Refik Anadol — «Wind of Boston: Data Paintings» ⭐ эталон «live-данные среды → амбиентное полотно»: https://refikanadolstudio.com/projects/wind-of-boston-data-paintings/
- Refik Anadol — «Unsupervised» (MoMA, латентное «сновидение»): https://refikanadol.com/works/unsupervised/
- Robert Hodgin — «Meander» (процедурные реки): https://roberthodgin.com/project/meander
- Daniel Shiffman — Perlin flow field + «The Nature of Code» (учебник по симуляции природных систем): https://thecodingtrain.com/challenges/24-perlin-noise-flow-field/ · https://natureofcode.com
- Zach Lieberman — Daily Sketches: https://www.lerandom.art/artists/zach-lieberman

### Live-feed инсталляции (модель «непрерывно обновляемый поток»)
- Aaron Koblin — «Flight Patterns» ⭐ live-позиции → светящийся поток: https://www.aaronkoblin.com/work/flightpatterns/
- Viégas & Wattenberg — «Wind Map» ⭐ непрерывно обновляемое амбиентное полотно: http://hint.fm/projects/wind/
- Ben Rubin & Mark Hansen — «Listening Post» (live-чат → 231 экран + сонификация): https://en.wikipedia.org/wiki/Listening_Post_(artwork)
- Ryoji Ikeda — «datamatics» (данные → аудиовизуальное возвышенное, жёсткая A/V-синхронизация): https://www.ryojiikeda.com/project/datamatics/
- teamLab (real-time, сенсорно-реактивные, «никогда не повторяется»): https://www.teamlab.art/
- Rafael Lozano-Hemmer — «Pulse» (live-биометрия/пульс): https://www.lozano-hemmer.com/pulse_topology.php

---

## 4. Абстрактные визуальные языки под «битву двух за территорию»

| Язык | Демо / референс | Почему ложится на футбол |
|---|---|---|
| **Flow fields** (Perlin/curl) | http://mfviz.com/flowFields/ · https://natureofcode.com | Два встречных поля → потоки сталкиваются по подвижному фронту, выпирающему в проигрывающую половину |
| **Reaction-diffusion** | https://www.karlsims.com/rd.html · https://jasonwebb.github.io/reaction-diffusion-playground/ | Каждая команда = реагент; одна органически захватывает территорию другой (фронты Тьюринга) |
| **Metaballs / blobs** | https://jamie-wong.com/2016/07/06/metaballs-and-webgl/ | Игрок = заряд скалярного поля; изолиния, где A>B — спорная граница, сливается и рвётся |
| **Voronoi / pitch control** ⭐ | https://d3js.org/d3-delaunay/voronoi · https://archive.trainingground.guru/articles/william-spearman-how-liverpool-create-pitch-control | Буквально две команды владеют пространством; клетки A переползают центр = «давят в чужую половину» |
| **Boids (флокинг)** | https://www.red3d.com/cwr/boids/ · https://p5js.org/examples/classes-and-objects-flocking/ | Две стаи-команды; согласованная атакующая стая отжимает обороняющуюся к воротам |
| **Slime mold / Physarum** | https://cargocollective.com/sagejenson/physarum · https://apps.amandaghassaei.com/gpu-io/examples/physarum/ | Две колонии строят конкурирующие сети; одна феромонная карта подавляет другую = инфильтрация |
| **Fluid sim** ⭐ | https://paveldogreat.github.io/WebGL-Fluid-Simulation/ · http://graphics.cs.cmu.edu/nsp/course/15-464/Fall09/papers/StamFluidforGames.pdf | Впрыск встречных цветных потоков; завихряющийся интерфейс = momentum, заливающий чужую половину под давлением |

---

## 5. Инструменты (под web-деплой полноэкранного real-time)

| Инструмент | Web | Вердикт |
|---|---|---|
| **three.js** (https://threejs.org) | да | **Дефолт.** GPGPU-частицы, bloom/post-FX, WebGPU+WebGL2 fallback |
| **regl** (https://regl-project.github.io/regl/) | да | Лучшее под чистую большую частичную/flow-систему |
| **OGL** (https://oframe.github.io/ogl/) | да | Крошечный, shader-first, под единое полотно |
| **PixiJS v8** (https://pixijs.com) | да | Топ по 2D-спрайтам/частицам, WebGPU backend |
| **p5.js** (https://p5js.org) | да | Прототип; слабоват на сотнях тысяч частиц |
| **Hydra** (https://hydra.ojack.xyz) | да | Визуальный синт / эстетический слой |
| **TouchDesigner** (https://derivative.ca) | нет | Под физическую инсталляцию, не под сайт |

Доказательство масштаба: 1–2 млн GPU-частиц @60fps в браузере —
https://github.com/poeti8/one-million-particles ·
https://discourse.threejs.org/t/gpgpu-galaxy-particles/88937

**Рекомендуемый стек:** прототип на p5.js/Hydra → продакшн на three.js
(WebGPURenderer + WebGL2 fallback, GPGPU ping-pong частицы), либо regl/OGL для
чистого 2D-потока.
