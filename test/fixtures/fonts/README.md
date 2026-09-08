# Шрифты для тестов

Минимальный шрифт в один прямоугольный глиф — по файлу на каждый поддерживаемый формат.
Содержимое глифа роли не играет: файлы нужны только затем, чтобы проверять распознавание
формата на настоящих заголовках, а не на выдуманных.

`fixture.ttf`, `fixture.otf`, `fixture.woff`, `fixture.woff2` и `fixture.svg` сделаны
`fontforge` из образа проекта. `fixture.eot` — тот же `fixture.ttf`, обёрнутый заголовком
EOT вручную: `fontforge` EOT не производит, а на просьбу выдаёт PostScript Type 1 с
расширением `.eot` (issue [#156](https://github.com/yuldashevsardor/telegram-bot/issues/156)).
