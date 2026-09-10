# Тесты и проверки

- `mocha` через `.mocharc.json` (`tsx/cjs`). Тот же `tsx` грузит `src/app.ts` в
  `npm run dev`, и алиас `app/*` он разрешает сам по `paths` — отдельный резолвер путей
  поэтому не нужен. Тиконфиг ему задаёт `TSX_TSCONFIG_PATH=./tsconfig.check.json` в
  npm-скриптах: `compilerOptions` применяются только к файлам из `include` тиконфига, а
  `test/**` есть лишь в `tsconfig.check.json` — сборочный `tsconfig.json` ограничен `src`
  и расширить его нельзя, тесты уехали бы в `build/`. Без этого файлы `test/` собирались
  бы дефолтами esbuild: стандартными декораторами вместо `experimentalDecorators` и
  `useDefineForClassFields: true` вместо проектного `false` — декоратор в спеке падал бы,
  а поле класса молча становилось `undefined`. Типы `tsx` не
  проверяет, это делает `npm run typecheck` по тому же `tsconfig.check.json`. Миграции
  идут мимо `tsx`, их грузит своим jiti `node-pg-migrate` ([`storage.md`](./storage.md)).
- Что покрыто — видно по дереву `test/` и отчёту `make coverage` (`nyc` считает по
  TypeScript-исходникам). Без автотестов остаются `Runner` (в том числе путь бана и
  повтора, [`task-queue.md`](./task-queue.md)), `FontConvertor`, пары без EOT,
  `Application`, `Bot` и `UserService`.
- Шрифты для тестов — `test/fixtures/fonts`; происхождение и способ пересборки описаны в
  `test/fixtures/fonts/README.md`.
- Строгость типов и правила линтера заданы в `tsconfig.json` и `.eslintrc.js`, там же
  комментариями объяснены неочевидные исключения: `skipLibCheck` вынужденный, пока
  `@types/node` зафиксированы на 17.x; исключения из `no-console` разобраны в
  [`logging.md`](./logging.md).
- Обязательного гейта нет. `pre-commit` — только удобство хостовой разработки (корневой
  [`README.md`](../../README.md), «Хук pre-commit»), CI пока не заведён (issue
  [#116](https://github.com/yuldashevsardor/telegram-bot/issues/116)).
- `.claude/settings.json` вешает `scripts/claude-worktree-guard.sh` на старт сессии и на
  правку файла: правка в основном дереве отклоняется. Правки через shell хук не видит.
