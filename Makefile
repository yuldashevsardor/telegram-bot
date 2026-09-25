# The single entry point for the frequent commands. The targets are shorter than the plain calls
# and cannot point at the wrong compose file. What happens inside — README.md.
#
# The database is one instance per machine: docker-compose.db.yml fixes the project name
# telegram-bot-db, so the database targets of every worktree reach the same container.
# The application's project name is unset on purpose: Compose takes it from the directory name,
# and every worktree gets an application of its own. Do not add -p for the application here: it
# would glue every worktree into one project.

DC_DB := docker compose -f docker-compose.db.yml
# .runtime.env is created before any compose call: it is bind-mounted by name
# (docker-compose.app.yml), and Docker creates a missing path as a root-owned directory
# (docs/architecture/invariants.md). An empty file changes nothing: the values come from the
# environment.
# The file is checked for, not touched every time. touch would bump its modification time on every
# target, and a running bot would rebuild its configuration on every make logs. On a root-owned
# directory touch would fail with "Permission denied" and take down targets that directory does not
# bother.
DC_APP := { [ -e .runtime.env ] || touch .runtime.env; } && docker compose -f docker-compose.app.yml
# One-off commands run in a throwaway container from the same image, not in the running one. So they
# do not need the bot up, and Compose builds the image itself when there is none. They still need
# the database up (make db-up): its network is declared external in docker-compose.app.yml, and
# without it the container does not start. The error then is about the network or the connection,
# not about a service that is not running.
DC_APP_RUN := $(DC_APP) run --rm app
BOT_TOKEN_SH := scripts/bot-token.sh

# The token lease expires by TTL, so it is renewed before the bot starts. A failure is a warning,
# not a stop: there may be no pool at all, with a single worktree and BOT_TOKEN written into .env
# by hand. In the main worktree renew leaves a token the pool does not know alone, in a
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

# coverage/ is created on the host beforehand, here and in check, which runs the same script.
# Otherwise Docker would create it owned by root, and the container, running as the user node,
# could not write into it.
coverage: ## Tests with coverage, red below the threshold; the table in the terminal, lcov in ./coverage
	@mkdir -p coverage
	$(DC_APP_RUN) npm run test:coverage

# The file set and the flags are written down once, in the npm scripts of package.json; the targets
# below only run them in the container. The checks without fixing are for review and CI. The edits
# on commit are still made by lint-staged; lint-fix and format are a one-off pass over the whole code.
#
# files="…" goes past the npm script, through npx: `npm run lint -- src/app.ts` would append the file
# to the script's arguments instead of replacing them, and the whole code would be checked anyway.
# The default list of prettier is .ts only: .prettierrc.js hard-codes parser: "typescript", which
# fails parsing .ftl and .md, and .prettierignore is empty.
#
# The list usually comes from git or gh with newlines, and make runs a recipe line by line: without
# collapsing them it would take the second file for a separate command.
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

# The run is long, so it is not part of check.
#
# The area goes into the container as the variable MUTATE, not as the flag --mutate: the flag would
# replace the whole mutate list of stryker.config.mjs together with its exclusions. The quotes make
# Stryker expand the glob, not the shell of the host. reports/ is created beforehand for the same
# reason as coverage/.
#
# The wrapper test/mutation-record.ts runs Stryker, writes the run record and exits with Stryker's
# code. The host counts the head and the number of changed paths for the record: .git is not mounted
# into the container. The paths are not counted by the pipeline `git status | wc -l`: its exit code
# is that of wc, so a failing git would give 0, "the tree is clean" where nobody looked. Hence a
# separate substitution with an exit code of its own, and "unknown", which the wrapper tells apart
# from a number.
#
# The run goes under caffeinate. It takes minutes, and an idle Mac falls asleep: the run stops with
# the machine, and after the wake-up the clock has moved on. Stryker's mutant timeout and the polls
# with deadlines of their own in the specs then fire on healthy mutants, and the status lies as it
# does under load (docs/architecture/testing.md, the paragraph on timeouts and errors).
# caffeinate goes to the background instead of standing as a prefix: $(DC_APP_RUN) is a compound
# command, and a prefix would reach only its first part. `-w $$` ties the ban to the shell of the
# recipe, so it lifts on any outcome: a red threshold, an error, Ctrl-C. The background job does not
# change the exit code of the target: that comes from the last command of the line.
# `caffeinate -i` does not prevent sleep from a closed lid. Linux has no caffeinate, and there the
# check leaves the target as it is.
mutation: ## Mutation testing, report and run record in ./reports: make mutation [files="src/shared/**"]
	@mkdir -p reports
	{ command -v caffeinate >/dev/null && caffeinate -i -w $$$$; } & \
		tree=$$(git status --porcelain) && dirty=$$(printf '%s' "$$tree" | awk 'END { print NR }') || dirty=unknown; \
		$(DC_APP_RUN) env MUTATION_HEAD="$$(git rev-parse HEAD)" MUTATION_DIRTY="$$dirty" \
		TSX_TSCONFIG_PATH=./tsconfig.check.json $(if $(FILES),MUTATE='$(FILES)') \
		node --require tsx/cjs test/mutation-record.ts

# A quick pass before a PR in one output: types, eslint, prettier, the tests with the coverage
# threshold. A green check does not yet mean a green review: review runs the same checks gate by
# gate and adds others, rebuild, build and mutation among them (docs/agents/review-gates.md).
check: ## Every check in a row, in one command
	@mkdir -p coverage
	$(DC_APP_RUN) npm run check

# The throwaway container takes the ready image and builds one itself only when there is none. Only
# part of the project is mounted (the list is in docker-compose.app.yml), the rest got into the
# image at build time. So after an edit to a file that is not mounted (README.md, "Commands") the
# image goes stale silently, and this target rebuilds it.
rebuild: ## Rebuild this worktree's application image
	$(DC_APP) build app

# exec on purpose: the target gets inside the running container, it does not bring up a new one.
shell: ## Shell in the running application container
	$(DC_APP) exec app sh

psql: ## psql in the database container
	$(DC_DB) exec pgsql sh -c 'psql -U "$$POSTGRES_USER" -d "$$DATABASE_NAME"'

## Worktrees and tokens

worktree-init: ## Prepare this task worktree: shared tmp/pgsql, own .env and BOT_TOKEN
	scripts/worktree-init.sh

# A tool, not automation: whoever calls the target decides "the PR is merged, time to clean up".
# The target only checks that cleaning up is already safe and does every step at once.
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

# The token is not taken through token=… on purpose: the arguments of make and of the script are
# visible in ps to any user of the machine, and the call stays in the shell history. The script asks
# for the token itself.
# The refusal below fires after the leak: make got the token in argv before the recipe started. So
# it says "revoke the token", not "try again". It looks at the origin of the variable: an
# environment variable of the same name never got into argv, and there is nothing to refuse. The
# value itself is not substituted into the recipe: it is not needed, and quotes inside it would
# break the parsing.
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

review-tree-create: ## Take the head of a PR into a temporary review tree <main worktree>-review-<PR>: make review-tree-create pr=<N>
	@[ -n "$(pr)" ] || { printf 'give it the PR: make review-tree-create pr=<N>\n' >&2; exit 1; }
	python3 scripts/review/tree_create.py '$(pr)'

# The recipe line is not echoed: stdout is the area itself, one path per line. DC_APP_RUN goes in
# whole, so the action runs node in the same container make mutation does: the one of `tree` when it
# is given. The two arguments go in a fixed order, the empty ones as empty strings.
mutation-area: ## The area of make mutation from the diff against origin/main, or from a PR's: make mutation-area [pr=<N>] [tree=<path>]
	@DC_APP_RUN='$(DC_APP_RUN)' python3 scripts/review/mutation_area.py '$(pr)' '$(tree)'

# The recipe line is not echoed: stdout is the answer the skill reads. The four arguments go in a
# fixed order, the empty ones as empty strings, and the area is joined into one line as for files.
mutation-record: ## Whether the last mutation run record of a PR replaces the reviewer's run: make mutation-record pr=<N> gate=mutation|mutation-full [area="<paths>"] [rebuild=1]
	@python3 scripts/review/mutation_record.py '$(pr)' '$(gate)' '$(strip $(subst $(NEWLINE), ,$(area)))' '$(rebuild)'

# The recipe line is not echoed: stdout is the report the skill reads. The three arguments go in a
# fixed order, the empty ones as empty strings.
review-run: ## The mechanical run of a PR review in one call, from the tree the review started in: make review-run pr=<N> gates="<gates>" [flags="--no-post"]
	@python3 scripts/review/review_run.py '$(pr)' '$(strip $(gates))' '$(strip $(flags))'

review-tree-remove: ## Remove a temporary review tree <main worktree>-review-<PR> with its image and volume: make review-tree-remove path=<tree>
	@[ -n "$(path)" ] || { printf 'give it the tree: make review-tree-remove path=<tree>\n' >&2; exit 1; }
	python3 scripts/review/tree_remove.py '$(path)'

.PHONY: up db-up app-up app-down db-down logs restart db-reset \
	migrate migrate-create build typecheck test test-watch coverage \
	lint lint-fix format-check format mutation check rebuild shell psql \
	worktree-init worktree-cleanup token-acquire token-renew token-release token-status token-add \
	review-test review-tree-create mutation-area mutation-record review-run review-tree-remove help
