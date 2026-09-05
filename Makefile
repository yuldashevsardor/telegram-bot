# Единственная точка входа для частых команд: цели короче прямых вызовов и не дают
# указать не тот compose-файл. Что именно происходит внутри — в README.md.
#
# База — один экземпляр на машину: имя проекта telegram-bot-db зафиксировано в самом
# docker-compose.db.yml, поэтому цели с базой из любого рабочего дерева попадают в один
# и тот же контейнер. У приложения имя проекта намеренно не задано — Compose берёт его
# из имени каталога, и каждое дерево получает своё приложение. Не добавляйте сюда -p
# для приложения: это склеит все деревья в один проект.

DC_DB := docker compose -f docker-compose.db.yml
DC_APP := docker compose -f docker-compose.app.yml
# Разовые команды идут не в работающий контейнер, а в одноразовый из того же образа: так они
# не требуют поднятого бота, а образ Compose при необходимости соберёт сам. Сеть базы объявлена
# в docker-compose.app.yml как внешняя, поэтому контейнер всё равно не стартует, пока не поднята
# база (make db-up) — но ошибка будет про сеть или подключение, а не про незапущенный сервис.
DC_APP_RUN := $(DC_APP) run --rm app
BOT_TOKEN_SH := scripts/bot-token.sh

# Аренда токена протухает по TTL, поэтому перед стартом бота её продлеваем. Пула может
# не быть вовсе — если работают в одном дереве и BOT_TOKEN вписан в .env руками; тогда
# это предупреждение, а не остановка запуска. Вписанный руками токен renew не трогает и
# при существующем пуле: слот занимается, только если BOT_TOKEN пуст или сам из пула.
RENEW_TOKEN = $(BOT_TOKEN_SH) renew || printf 'предупреждение: аренда BOT_TOKEN не продлена, .env остаётся как есть\n' >&2

.DEFAULT_GOAL := help

## Окружение

up: ## Поднять базу (если не поднята) и приложение этого дерева
	@$(MAKE) --no-print-directory db-up
	@$(RENEW_TOKEN)
	$(DC_APP) up --build

db-up: ## Поднять только базу (общую для всех деревьев)
	$(DC_DB) up -d

app-up: ## Поднять только приложение этого дерева (база должна уже работать)
	@$(RENEW_TOKEN)
	$(DC_APP) up --build

app-down: ## Погасить приложение этого дерева (базу не трогает)
	$(DC_APP) down

db-down: ## Погасить базу (её потеряют все деревья)
	$(DC_DB) down

logs: ## Логи приложения этого дерева
	$(DC_APP) logs -f app

# Не `docker compose restart`: он перезапускает существующий контейнер, не пересоздавая
# его, поэтому env_file заново не читается. Если renew занял другой слот, контейнер так и
# остался бы на старом токене, который к этому моменту мог уйти другому дереву.
restart: ## Пересоздать контейнер приложения этого дерева
	@$(RENEW_TOKEN)
	$(DC_APP) up -d --force-recreate app

db-reset: ## Погасить базу и стереть её данные (общие для всех деревьев; спросит подтверждение)
	@scripts/db-reset.sh

## Внутри контейнеров

migrate: ## Накатить миграции
	$(DC_APP_RUN) npm run migrate -- up

migrate-create: ## Создать файл миграции: make migrate-create name=add-something
	@[ -n "$(name)" ] || { printf 'укажите имя: make migrate-create name=add-something\n' >&2; exit 1; }
	$(DC_APP_RUN) npm run migrate -- create $(name)

build: ## Проверка типов и сборка
	$(DC_APP_RUN) npm run build

typecheck: ## Проверить типы без сборки
	$(DC_APP_RUN) npm run typecheck

test: ## Прогнать тесты
	$(DC_APP_RUN) npm test

# src и test смонтированы с хоста, поэтому mocha в контейнере видит правки в редакторе.
test-watch: ## Тесты в режиме watch (выход — Ctrl-C)
	$(DC_APP_RUN) npm run test:watch

# Каталог создаём на хосте заранее: несуществующий путь Docker создал бы сам, но от root,
# а в контейнере работает пользователь node — писать в такой каталог он бы не смог.
coverage: ## Тесты с покрытием; таблица в терминал, lcov — в ./coverage
	@mkdir -p coverage
	$(DC_APP_RUN) npm run test:coverage

# Набор файлов и флаги описаны один раз — в npm-скриптах (package.json), цели ниже только
# запускают их в контейнере. Проверки без правок нужны для ревью и CI; правки при коммите
# по-прежнему делает lint-staged, а lint-fix и format — это разовый проход по всему коду.
#
# Сужение до списка файлов идёт мимо скрипта, через npx: `npm run lint -- src/app.ts`
# дописал бы файл к аргументам скрипта, а не заменил их, и проверился бы всё равно весь
# код. У prettier свой список по умолчанию — только .ts: .prettierrc.js жёстко задаёт
# parser: "typescript", на .ftl и .md он падает разбором, а .prettierignore пуст.
#
# Список обычно приходит из git или gh и содержит переносы строк, а рецепт — построчный:
# без схлопывания make принял бы второй файл за отдельную команду.
define NEWLINE


endef
FILES = $(strip $(subst $(NEWLINE), ,$(files)))

lint: ## Проверить eslint без правок: make lint [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx eslint $(FILES),npm run lint)

lint-fix: ## Исправить, что умеет eslint: make lint-fix [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx eslint --fix $(FILES),npm run lint:fix)

format-check: ## Проверить prettier без правок: make format-check [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx prettier --check $(FILES),npm run format:check)

format: ## Переформатировать prettier: make format [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx prettier --write $(FILES),npm run format)

# То же, что прогоняет ревью и что стоит прогнать перед PR: типы, eslint, prettier, тесты.
check: ## Все проверки подряд одной командой
	$(DC_APP_RUN) npm run check

# Одноразовый контейнер берёт готовый образ и сам пересобирает его только когда образа нет.
# Томами монтируются лишь src, test, tsconfig.json, tsconfig.check.json, migrate.json и coverage,
# всё остальное попало в образ на сборке — поэтому после изменения package.json,
# package-lock.json, .mocharc.json, .eslintrc.js или .prettierrc.js образ устаревает молча,
# и его нужно пересобрать этой целью.
rebuild: ## Пересобрать образ приложения этого дерева
	$(DC_APP) build app

# Здесь exec намеренно: смысл цели — попасть внутрь работающего контейнера, а не поднять новый.
shell: ## Шелл в работающем контейнере приложения
	$(DC_APP) exec app sh

psql: ## psql в контейнере базы
	$(DC_DB) exec pgsql sh -c 'psql -U "$$POSTGRES_USER" -d "$$DATABASE_NAME"'

## Рабочие деревья и токены

worktree-init: ## Подготовить это дерево задачи: общий tmp/pgsql, свой .env и BOT_TOKEN
	scripts/worktree-init.sh

token-acquire: ## Занять свободный слот пула за этим деревом
	$(BOT_TOKEN_SH) acquire

token-renew: ## Продлить аренду слота этого дерева
	$(BOT_TOKEN_SH) renew

token-release: ## Освободить слот этого дерева
	$(BOT_TOKEN_SH) release

token-status: ## Показать занятость слотов пула
	$(BOT_TOKEN_SH) status

# Токен не принимается через token=… намеренно: аргументы make и скрипта видны в ps любому
# пользователю машины, а вызов оседает в истории шелла. Скрипт спрашивает токен сам. Отказ
# ниже срабатывает уже после утечки — make получил токен в argv раньше, чем начался рецепт,
# — поэтому он говорит не «повторите», а «отзовите токен». Смотрим именно origin: одноимённая
# переменная окружения в argv не попадала, из-за неё отказывать не за что. Само значение в
# рецепт не подставляется — незачем, да и кавычки в нём сломали бы разбор.
token-add: ## Дописать токен в конец пула (спросит токен, ввод не отображается)
	@[ -z "$(filter command line,$(origin token))" ] || { \
		printf 'токен не передаётся через token=… — он уже попал в argv make и виден в ps, а вызов остался в истории шелла\n' >&2; \
		printf 'считайте этот токен скомпрометированным: отзовите его у @BotFather и добавьте новый через make token-add без параметров\n' >&2; \
		exit 1; \
	}
	@$(BOT_TOKEN_SH) add

help: ## Показать этот список
	@awk 'BEGIN { FS = ":.*## " } \
		/^## / { printf "\n%s\n", substr($$0, 4); next } \
		/^[a-z][a-zA-Z0-9_-]*:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo

.PHONY: up db-up app-up app-down db-down logs restart db-reset \
	migrate migrate-create build typecheck test test-watch coverage \
	lint lint-fix format-check format check rebuild shell psql \
	worktree-init token-acquire token-renew token-release token-status token-add help
