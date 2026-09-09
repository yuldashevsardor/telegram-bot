# Трекер задач: GitHub

Задачи живут в GitHub Issues, операции — через `gh` CLI; репозиторий он определяет по
`git remote`.

- Многострочное тело — через `--body-file <файл>`, не через `--body`.
- Всё, что уходит на GitHub от аккаунта владельца, несёт подпись из раздела «Подпись
  агента на GitHub» в `CLAUDE.md`.
- Лейблы штатные: `bug`, `enhancement`, `documentation`. Триаж-машина скилла `triage` и
  её лейблы (`needs-triage` и т. п.) не используются, `docs/agents/triage-labels.md` нет
  намеренно.
- Голый `#42` может быть и issue, и PR: сначала `gh pr view 42`, при неудаче
  `gh issue view 42`.

## PR как поверхность запросов: нет

_(Поставьте «да», если внешние PR должны попадать в очередь разбора наравне с issues.)_

## Когда скилл говорит «опубликовать в трекер»

Завести GitHub issue. Работа по ней — отдельная ветка и PR, см. «Рабочий процесс»
в `CLAUDE.md`.

## Операции wayfinding

Используются скиллом `wayfinder`. Карта — одна issue с лейблом `wayfinder:map`, тикеты —
дочерние issues (GitHub sub-issues). Блокировки — нативные зависимости GitHub:

```bash
gh api --method POST repos/<owner>/<repo>/issues/<тикет>/dependencies/blocked_by \
  -F issue_id=<id блокировщика>
```

`issue_id` — числовой id issue в базе GitHub, а не её номер `#<n>`; взять его —
`gh api repos/<owner>/<repo>/issues/<n> --jq .id`. Тикет свободен, когда все его
блокировщики закрыты.
