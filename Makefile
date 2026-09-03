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
BOT_TOKEN_SH := scripts/bot-token.sh

# Аренда токена протухает по TTL, поэтому перед стартом бота её продлеваем. Пула может
# не быть вовсе — если работают в одном дереве и BOT_TOKEN вписан в .env руками; тогда
# это предупреждение, а не остановка запуска.
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

restart: ## Перезапустить приложение этого дерева
	@$(RENEW_TOKEN)
	$(DC_APP) restart app

db-reset: ## Погасить базу и стереть её данные (tmp/pgsql — общий для всех деревьев)
	$(DC_DB) down
	@data=$$(cd tmp/pgsql 2>/dev/null && pwd -P || true); \
	if [ -n "$$data" ]; then \
		rm -rf "$$data"; \
		mkdir -p "$$data"; \
		printf 'данные базы удалены: %s\n' "$$data"; \
	else \
		printf 'каталога tmp/pgsql нет, удалять нечего\n'; \
	fi

## Внутри контейнеров

migrate: ## Накатить миграции
	$(DC_APP) exec app npm run migrate -- up

migrate-create: ## Создать файл миграции: make migrate-create name=add-something
	@[ -n "$(name)" ] || { printf 'укажите имя: make migrate-create name=add-something\n' >&2; exit 1; }
	$(DC_APP) exec app npm run migrate -- create $(name)

build: ## Проверка типов и сборка
	$(DC_APP) exec app npm run build

test: ## Прогнать тесты
	$(DC_APP) exec app npm test

shell: ## Шелл в контейнере приложения
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

token-add: ## Дописать токен в конец пула: make token-add token=<токен от @BotFather>
	@[ -n "$(token)" ] || { printf 'укажите токен: make token-add token=<токен от @BotFather>\n' >&2; exit 1; }
	@$(BOT_TOKEN_SH) add '$(token)'

help: ## Показать этот список
	@awk 'BEGIN { FS = ":.*## " } \
		/^## / { printf "\n%s\n", substr($$0, 4); next } \
		/^[a-z][a-zA-Z0-9_-]*:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo

.PHONY: up db-up app-up app-down db-down logs restart db-reset \
	migrate migrate-create build test shell psql \
	worktree-init token-acquire token-renew token-release token-status token-add help
