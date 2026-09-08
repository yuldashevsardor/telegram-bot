# Шрифтовые фикстуры

Один и тот же Roboto-Black в шести форматах — вход для ручных прогонов конвертации, для
`/font_generator` и для спека `FontSignatureMatcher`, которому нужны настоящие заголовки,
а не выдуманные. Каталог лежит в `test/`, а не в `tmp/`, как раньше: `tmp` перечислен в
`.dockerignore` и вдобавок перекрыт томом `app-tmp`, поэтому файлы оттуда до контейнера не
доезжали вовсе.

Базовый формат — `test-font.ttf`. Остальное делается из него в образе приложения,
штатным скриптом конвертации (`FontForge.convertScript`):

```sh
fontforge -c 'import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])' \
    test-font.ttf test-font.<otf|woff|woff2|svg>
```

`test-font.eot` этой командой получить нельзя: расширения `.eot` fontforge не знает и
молча пишет вместо EOT PostScript Type 1 — именно так в репозитории и появились две
фикстуры не того формата (issue
[#153](https://github.com/yuldashevsardor/telegram-bot/issues/153)). EOT сделан сторонней
утилитой, в образ она не входит:

```sh
npx ttf2eot test-font.ttf test-font.eot
```

Открыть готовый EOT fontforge тоже не может, поэтому пары `eot-to-*` и `*-to-eot` сейчас
нерабочие (issue [#158](https://github.com/yuldashevsardor/telegram-bot/issues/158)).
Фикстура лежит здесь настоящей, чтобы после починки её не пришлось заводить заново.

Формат каждого файла сверяется по сигнатуре — на этом же держится спек
`FontSignatureMatcher`, так что замену стоит проверять теми же признаками:

| файл | признак |
|---|---|
| `test-font.ttf` | `00 01 00 00` |
| `test-font.otf` | `OTTO` |
| `test-font.woff` | `wOFF` |
| `test-font.woff2` | `wOF2` |
| `test-font.eot` | `0x504C` на смещении 34, `EOTSize` в первых четырёх байтах равен размеру файла |
| `test-font.svg` | сигнатуры нет, XML |
