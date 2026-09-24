# The single entry point for the frequent commands: the targets are shorter than the plain
# calls and leave no room for pointing at the wrong compose file. What happens inside — README.md.
#
# The database is one instance per machine: the project name telegram-bot-db is fixed in
# docker-compose.db.yml itself, so the database targets from any worktree land in the same
# container. The application's project name is deliberately unset — Compose takes it from the
# directory name, and every worktree gets an application of its own. Do not add -p for the
# application here: that would glue every worktree into one project.

DC_DB := docker compose -f docker-compose.db.yml
# The hot configuration file is mounted into the container by name (docker-compose.app.yml), and
# a bind-mount of a path that does not exist Docker creates as a directory owned by root: the
# application would fail reading the configuration, and removing such a directory would take sudo.
# So the file appears before any compose call, and an empty one changes nothing — the values come
# from the environment.
# An existence check rather than an unconditional touch: touch would bump the modification time on
# every target, a running bot would rebuild its configuration on every make logs, and on a
# root-owned directory it would fail with "Permission denied", taking down the target that
# directory does not bother.
DC_APP := { [ -e .runtime.env ] || touch .runtime.env; } && docker compose -f docker-compose.app.yml
# One-off commands go to a throwaway container from the same image instead of the running one: that
# way they do not need the bot up, and Compose builds the image itself when there is none. The
# database network is declared external in docker-compose.app.yml, so the container still does not
# start until the database is up (make db-up) — but the error will be about the network or the
# connection, not about a service that is not running.
DC_APP_RUN := $(DC_APP) run --rm app
BOT_TOKEN_SH := scripts/bot-token.sh

# The token lease expires by TTL, so it is renewed before the bot starts. There may be no pool at
# all — working in a single worktree with BOT_TOKEN written into .env by hand; then this is a
# warning, not a stop. In the main worktree renew leaves a token the pool does not know alone, in a
# task worktree it does not (README.md, "The token pool").
RENEW_TOKEN = $(BOT_TOKEN_SH) renew || printf 'warning: the BOT_TOKEN lease was not renewed, .env is left as it is\n' >&2

.DEFAULT_GOAL := help

## Environment

up: ## Bring up the database (if it is down) and this worktree's application
	@$(MAKE) --no-print-directory db-up
	@$(RENEW_TOKEN)
	$(DC_APP) up --build

db-up: ## Bring up the database alone (shared by every worktree)
	$(DC_DB) up -d

app-up: ## Bring up this worktree's application alone (the database must already run)
	@$(RENEW_TOKEN)
	$(DC_APP) up --build

app-down: ## Take down this worktree's application (leaves the database alone)
	$(DC_APP) down

db-down: ## Take down the database (every worktree loses it)
	$(DC_DB) down

logs: ## Logs of this worktree's application
	$(DC_APP) logs -f app

# Not `docker compose restart`: it restarts the existing container without recreating it, so
# env_file is not read again. If renew took a different slot, the container would stay on the old
# token, which by then could have gone to another worktree.
restart: ## Recreate this worktree's application container
	@$(RENEW_TOKEN)
	$(DC_APP) up -d --force-recreate app

db-reset: ## Take the database down and wipe its data (shared by every worktree; asks for confirmation)
	@scripts/db-reset.sh

## Inside the containers

migrate: ## Run the migrations
	$(DC_APP_RUN) npm run migrate -- up

migrate-create: ## Create a migration file: make migrate-create name=add-something
	@[ -n "$(name)" ] || { printf 'give it a name: make migrate-create name=add-something\n' >&2; exit 1; }
	$(DC_APP_RUN) npm run migrate -- create $(name)

build: ## Check the types and build
	$(DC_APP_RUN) npm run build

typecheck: ## Check the types without building
	$(DC_APP_RUN) npm run typecheck

test: ## Run the tests
	$(DC_APP_RUN) npm test

# src and test are mounted from the host, so mocha in the container sees the edits in the editor.
test-watch: ## Tests in watch mode (Ctrl-C to leave)
	$(DC_APP_RUN) npm run test:watch

# The directory is created on the host beforehand (and in check, which runs the same script): a path
# that does not exist Docker would create itself, but owned by root, and the container runs as the
# user node, which could not write into such a directory.
coverage: ## Tests with coverage, red below the threshold; the table in the terminal, lcov in ./coverage
	@mkdir -p coverage
	$(DC_APP_RUN) npm run test:coverage

# The file set and the flags are written down once — in the npm scripts (package.json); the targets
# below only run them in the container. The checks without fixing are for review and CI; the edits
# on commit are still made by lint-staged, and lint-fix and format are a one-off pass over the whole
# code.
#
# Narrowing to a list of files goes past the script, through npx: `npm run lint -- src/app.ts` would
# append the file to the arguments of the script instead of replacing them, and the whole code would
# be checked anyway. prettier has a default list of its own — .ts only: .prettierrc.js hard-codes
# parser: "typescript", on .ftl and .md it fails parsing, and .prettierignore is empty.
#
# The list usually comes from git or gh and carries newlines, while a recipe goes line by line:
# without collapsing them make would take the second file for a separate command.
define NEWLINE


endef
FILES = $(strip $(subst $(NEWLINE), ,$(files)))

lint: ## Check with eslint without fixing: make lint [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx eslint $(FILES),npm run lint)

lint-fix: ## Fix what eslint can: make lint-fix [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx eslint --fix $(FILES),npm run lint:fix)

format-check: ## Check with prettier without rewriting: make format-check [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx prettier --check $(FILES),npm run format:check)

format: ## Reformat with prettier: make format [files="src/app.ts"]
	$(DC_APP_RUN) $(if $(FILES),npx prettier --write $(FILES),npm run format)

# The run is long, so it is not part of check. The area goes into the container as the variable
# MUTATE, not as the flag --mutate: the flag would replace the whole mutate list of
# stryker.config.mjs together with its exclusions. The quotes are there so that Stryker expands the
# glob and not the shell of the host. The report directory is created beforehand for the same reason
# as for coverage.
#
# Stryker is run by the wrapper test/mutation-record.ts: it writes the run record and exits with
# Stryker's code. The head and the number of changed paths for the record are counted by the host:
# .git is not mounted into the container. The number of paths is not counted by the pipeline
# `git status | wc -l`: the exit code of a pipeline is the code of wc, so a failing git would give 0,
# that is "the tree is clean" where nobody looked. Hence a separate substitution with an exit code of
# its own and the unknown that the wrapper tells apart from a number.
#
# The run takes minutes, and a Mac with no user action falls asleep on idle: the run stops together
# with the machine, and after the wake-up the clock has moved on — Stryker's mutant timeout and the
# polls with deadlines of their own in the specs fire on healthy mutants, and the status lies the
# same way it does under load (docs/architecture/testing.md, the paragraph on timeouts and errors).
# So the run goes under caffeinate. It goes to the background instead of standing as a prefix:
# $(DC_APP_RUN) is a compound command, and the prefix would reach only its first part. `-w $$` ties
# the ban to the shell of the recipe, and it lifts itself on any outcome — after a red threshold, an
# error and Ctrl-C. The background job does not change the exit code of the target: that comes from
# the last command of the line. Sleep from a closed lid `caffeinate -i` does not cancel. On Linux
# there is no caffeinate — there the check leaves the target as it is.
mutation: ## Mutation testing, report and run record in ./reports: make mutation [files="src/shared/**"]
	@mkdir -p reports
	{ command -v caffeinate >/dev/null && caffeinate -i -w $$$$; } & \
		tree=$$(git status --porcelain) && dirty=$$(printf '%s' "$$tree" | awk 'END { print NR }') || dirty=unknown; \
		$(DC_APP_RUN) env MUTATION_HEAD="$$(git rev-parse HEAD)" MUTATION_DIRTY="$$dirty" \
		TSX_TSCONFIG_PATH=./tsconfig.check.json $(if $(FILES),MUTATE='$(FILES)') \
		node --require tsx/cjs test/mutation-record.ts

# A quick pass before a PR in one output: types, eslint, prettier, the tests with the coverage
# threshold. Review checks the same, but runs its gates one by one and adds rebuild, build and
# mutation to them, so a green check does not yet mean review will be green.
check: ## Every check in a row, in one command
	@mkdir -p coverage
	$(DC_APP_RUN) npm run check

# The throwaway container takes the ready image and rebuilds it itself only when there is no image.
# Only part of the project is mounted as volumes (the list is in docker-compose.app.yml), everything
# else got into the image at build time — so after an edit to a file that is not mounted
# (package.json, the lock file, the test and linter configs) the image goes stale silently, and this
# target is what rebuilds it.
rebuild: ## Rebuild this worktree's application image
	$(DC_APP) build app

# exec here on purpose: the point of the target is to get inside the running container, not to bring
# up a new one.
shell: ## Shell in the running application container
	$(DC_APP) exec app sh

psql: ## psql in the database container
	$(DC_DB) exec pgsql sh -c 'psql -U "$$POSTGRES_USER" -d "$$DATABASE_NAME"'

## Worktrees and tokens

worktree-init: ## Prepare this task worktree: shared tmp/pgsql, own .env and BOT_TOKEN
	scripts/worktree-init.sh

# A tool, not automation: the decision "the PR is merged, time to clean up" is made by whoever calls
# the target — it only checks that cleaning up is already safe and does every step at once.
worktree-cleanup: ## Clean this task worktree up after the PR is merged (application, worktree, branch) and pull main in the main worktree
	scripts/worktree-cleanup.sh

token-acquire: ## Lease a free pool slot for this worktree
	$(BOT_TOKEN_SH) acquire

token-renew: ## Extend the lease of this worktree's slot
	$(BOT_TOKEN_SH) renew

token-release: ## Free this worktree's slot
	$(BOT_TOKEN_SH) release

token-status: ## Show which slots of the pool are taken
	$(BOT_TOKEN_SH) status

# The token is deliberately not taken through token=…: the arguments of make and of the script are
# visible in ps to any user of the machine, and the call stays in the shell history. The script asks
# for the token itself. The refusal below fires when the leak has already happened — make got the
# token in argv before the recipe started — so it says not "try again" but "revoke the token". It is
# origin that is looked at: an environment variable of the same name never got into argv, there is
# nothing to refuse for. The value itself is not substituted into the recipe — no need, and quotes
# inside it would break the parsing.
token-add: ## Append a token to the end of the pool (asks for the token, the input is not shown)
	@[ -z "$(filter command line,$(origin token))" ] || { \
		printf 'the token is not passed through token=… — it is already in the argv of make, visible in ps, and the call stayed in the shell history\n' >&2; \
		printf 'treat this token as compromised: revoke it at @BotFather and add a new one with make token-add and no parameters\n' >&2; \
		exit 1; \
	}
	@$(BOT_TOKEN_SH) add

help: ## Show this list
	@awk 'BEGIN { FS = ":.*## " } \
		/^## / { printf "\n%s\n", substr($$0, 4); next } \
		/^[a-z][a-zA-Z0-9_-]*:.*## / { printf "  %-19s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo

## Review tooling

# The actions of the review skills are Python on the host (docs/architecture/testing.md): they drive
# docker and git from outside the containers, and their specs replace both, so they take seconds.
review-test: ## Run the specs of the review actions (Python on the host, no Docker)
	cd scripts/review && python3 -m unittest discover -p 'test_*.py'

review-tree-remove: ## Remove a temporary review tree with its image and volume: make review-tree-remove path=../telegram-bot-review-7
	@[ -n "$(path)" ] || { printf 'give it the tree: make review-tree-remove path=../telegram-bot-review-7\n' >&2; exit 1; }
	python3 scripts/review/tree_remove.py '$(path)'

.PHONY: up db-up app-up app-down db-down logs restart db-reset \
	migrate migrate-create build typecheck test test-watch coverage \
	lint lint-fix format-check format mutation check rebuild shell psql \
	worktree-init worktree-cleanup token-acquire token-renew token-release token-status token-add \
	review-test review-tree-remove help
