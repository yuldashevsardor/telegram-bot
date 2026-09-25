# CLAUDE.md

A Telegram bot that converts fonts. The core domain is `src/font-convertor/`; Telegram,
`User`, PostgreSQL and the rest of the infrastructure serve it.

## Documentation

Read for the task at hand, not front to back:

- Naming a domain concept (an issue title, a test name, a class name) — `CONTEXT.md`.
- Editing code — the file of the affected subsystem in `docs/architecture/`: its structure
  and runtime sequences live there. Which file is whose is told by the table of contents and
  the directory map in `docs/architecture/README.md`. Whatever your edit made false in that
  file, fix in the same PR: it is not neighbouring code.
- The environment does not come up, or you need tokens, compose or variables — `README.md`.
- Filing or running a task — it lives in GitHub Issues, handled through `gh`:
  `docs/agents/issue-tracker.md`; how skills read the domain docs — `docs/agents/domain.md`.

## Editing documentation

Appending a paragraph is cheaper than rereading the document, and that is how the sediment
builds up. Four checks at the moment of writing, each cheaper than the paragraph itself:

- **A statement about code comes from an open file**, and the text names the file, symbol
  or command it was checked against. A paragraph written from memory is a fresh lie.
- **An issue link is a source, not the carrier of meaning.** Close the issue in your head:
  the paragraph must stay true. "Temporary files are not deleted (issue #37)" passes, "known
  problem, see #N" does not.
- **A duplicate costs more than a link.** Before a new paragraph, `grep -rn <identifier>`
  over every `*.md` in the repository; found in another file or section — edit what you
  found, do not start a second copy.
- **A list derivable from the code is not written down**: a list that one command prints or
  that lies whole in one file is replaced by where to look. Not derivable — allowed: what the
  tests do not cover cannot be read off the `test/` tree.

Fix what is false, not the style: errors settle where the text is new. The "why", a rejected
alternative, a trap and the cost of getting it wrong cannot be recovered from the code — they
are shortened only when the code has cancelled them.

## Workflow

- Every task gets its own git worktree and branch, and ends as a PR into `main`. Creating
  the worktree is the first step, before any edit:

  ```bash
  git worktree add "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")-<task>" -b <branch> origin/main
  ```

  The path must be absolute: git resolves a relative one from its own current directory. It is
  built from the common git directory, not from `--show-toplevel`: run from a task worktree,
  that one names the task worktree, and the new one would be named after it instead of after
  the main worktree.
- Code in the main worktree is not edited: a neighbouring session will switch the branch
  there and carry the uncommitted edits away.
- After creating the worktree — `make worktree-init`; after the PR is merged (and only
  then) — `make worktree-cleanup` in the task worktree (its checks and what it does
  irreversibly are in `README.md`, "Working in several worktrees"). A worktree left behind
  reads to the next session as a task in progress.
- One branch/PR — one task. Before a commit — `git status -sb`. Do not commit to `main`
  directly: the branch is protected on GitHub.
- Language: repository files, GitHub texts (issue bodies, PR descriptions, review and PR
  comments) and commit messages are English; code identifiers are not translated. A session
  conversation with the owner stays Russian. `src/**/locale/*.ru.ftl` is the bot's own speech,
  product content, and stands outside this rule. Russian text still in the repository is a
  leftover, not a violation: #385 translates it area by area.

## Commands

Only through `make`: Node and npm live in the image, not on the host, so plain `npm` and
`npx` will not work. `make` with no arguments prints the targets with their descriptions.
Before a PR — `make check`. Do not bypass the safeguards of `make db-reset`: the database is
shared by every worktree, and a reset wipes it for the neighbouring sessions too.

## Scope

The minimal change for the task. Leave neighbouring code, the architecture and problems
found along the way alone — report the problem or file an issue. New abstractions and
multi-area refactoring only on explicit request. Follow the project's existing decisions.

## Style

- Internal imports only through `app/*`, the shared code of the specs through `test/*`
  (the exception is the migration files).
- New files are kebab-case.
- A directory inside a subsystem is created on at least one of four grounds: it hides one
  file (only that file is imported from outside, the rest of the directory is its insides),
  it gathers same-kind siblings of one contract, it keeps a main file together with its
  `*.types.ts` and `*.errors.ts` companions, or it stands around one sibling that has files
  of its own (`locale/` bundles) or a role of its own among the siblings. No ground — the
  files lie flat. The directory name follows the rule in the directory map section of
  `docs/architecture/README.md`, except in `shared/`: there a directory is named by its role
  (`fs/`, `string/`). The same section holds the examples, the exceptions, the rule for laying
  out the specs and the commands that check it.
- The domain does not depend on grammY, PostgreSQL or pino. The linter does not check this.
- A bare `Error` is not thrown outwards: at least `RuntimeError` from `app/shared/errors`,
  better a subclass of your own in `<module>.errors.ts` next to the throwing code. The second
  argument is either the original error (it goes to `cause`) or a details object (it goes to
  `payload`); when both are needed, the error goes into the object as its `cause` field.
- Comments only about the non-obvious: why, not what.

## Invariants

Some rules are not checked by the code, and breaking them breaks behaviour silently. Read
`docs/architecture/invariants.md` before editing — in particular when you touch the bot
pipeline and `Context`, `container.ts` and dependency injection, the configuration,
migrations and the `sessions` schema, the `User` fields, the shutdown deadlines, the queue
limits, the convertor, running external processes, or the locales.

## Agent signature on GitHub

The agent works through `gh` from the owner's account, so everything it posts on GitHub
(PR and issue comments, replies to inline review, issue bodies) ends with the line:

```
_🤖 Posted by Claude Code from the owner's account · [session](<session link>)_
```

The link is the same as in the commit's `Claude-Session` trailer. No link — the signature
goes without it: `_🤖 Posted by Claude Code from the owner's account._`
PR descriptions and commit messages need no signature: they carry their own mark.
