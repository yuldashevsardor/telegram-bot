# pr-light-check: the standalone mode

Steps 4–6, read by the standalone mode after step 3 of `SKILL.md`. The mechanical mode does not
read this file. The steps are numbered as in `SKILL.md`.

## Step 4. Issue compliance

The run answers "is anything broken", the verdict answers "can it be merged". The second cannot be
checked without the issue: a green run on a PR that touches only the `Makefile` means only that
nothing failed, not that what was asked for was done.

Find the issue link in the PR body (`Closes #N`, `Fixes #N`, `#N`):

```bash
gh pr view <N> --json number,title,body,headRefName,baseRefName,files
gh issue view <M> --json number,title,body,labels
```

- No issue link → verdict **BLOCKED**: there is nothing to check the acceptance criteria against.
- There is a link → write out the list of criteria from the issue body (explicit items or implicit
  requirements). Give each `met` / `not met` / `not covered by the diff` with a file and a line.
- Check the reverse direction: whether the diff has changes the issue did not ask for. By the
  repository rule one branch is one coherent task, and unrelated changes in the same PR are grounds
  for `REQUEST_CHANGES`.
- `baseRefName` must be `main`.

If the diff touches `CLAUDE.md`, `docs/**`, `README.md` or adds a new document, the lines it
writes must be English; code identifiers stay as they are. Russian outside the changed lines is not
a finding: it is a leftover the translation of #385 missed.

## Step 5. Verdict

### Run number

Verdicts on one PR must differ. The run identifier is a count of the hidden
`<!-- pr-light-check` marker in the PR comments, not a date and not a guess.

```bash
gh pr view <N> --json comments -q '[.comments[].body | select(contains("<!-- pr-light-check"))] | length'
gh pr view <N> --json headRefOid -q '.headRefOid[0:7]'
```

The first command gives the number of past runs, `K-1`; your run is `K`. The `pr-light-check`
marker does not mix with the `pr-deep-review` marker: those are separate counters.

### Text

```
## Light check of PR #<N> — issue #<M> · run #<K> · commit <sha>

**Verdict:** APPROVE | REQUEST_CHANGES | BLOCKED

Checked: the run + the changed documentation lines + the changed comments against the code + issue compliance
Not checked: invariants, bugs, smells, overlaps with open PRs, documentation outside the diff

### Issue compliance
- <criterion> — met / not met / not covered (file.ts:42)

### Run
rebuild: done/not needed · build: ok/fail/n-a · typecheck: ok/fail/n-a · test: ok/fail/n-a · lint: ok/fail/n-a · format-check: ok/fail/n-a · python: ok/fail/n-a
mutation: ok/fail/n-a — <score from Final mutation score>, <the whole src/ or the area files> · accepted record, <link> (head <sha> is earlier — nothing under the mutation gates came in since) | own run — <why the record was not accepted> (n-a — the reason)
make -n <target>: ok/fail — <what the expansion showed>
sh -n <script>: ok/fail (+ dash: ok/fail/n-a)
Not run: <check> — <reason>
Not cleaned up: <temporary path> — <the reason from the make review-tree-remove output>

### Documentation
issue links: ok/findings/n-a · <file.md> "<quoted line>" — #<M> is closed, the paragraph presents it as a live problem
lists and duplicates: ok/findings/n-a · <file.md> "<quoted line>" — <what prints the list or where the duplicate lies>
comments: ok/findings/n-a · <file.ts:line> "<quoted comment>" — <what the code does | where the same claim still says otherwise | a changed line of code: the full review was needed>

### Red
- <command> — <the first meaningful line of the error> [brought by this PR | red on the base too]

### Summary
<1–3 sentences: it can be merged, or what exactly to fix>

_🤖 Posted by Claude Code from the owner's account · [session](<session link>)_

<!-- pr-light-check run=<K> head=<sha> -->
```

- The "Not checked" line is required and must not be dropped: without it a green verdict reads as a
  full review, which it is not.
- Move from "Checked" to "Not checked": the documentation when the `docs` gate is off, the comments
  when the `comments` gate is off, the run when not a single run gate is on.
- The signature is required: the verdict goes out from the owner's account and without it reads as
  written by the owner ("Agent signature on GitHub" in `CLAUDE.md`). No session link — leave
  `_🤖 Posted by Claude Code from the owner's account._`
- The marker is the last line, exactly in this form and without indentation: the next run counts
  its number by it. The signature goes before it: the marker is invisible in the feed and does not
  work as a signature.

### Verdict rules

- **APPROVE** — everything that ran passed and the issue criteria are met. An empty run (a
  documentation-only diff) does not stand in the way.
- **REQUEST_CHANGES** — there is red brought by this PR, or a documentation finding, or an unmet
  issue criterion, or changes the issue did not ask for.
- **BLOCKED** — there is nothing to judge by:
  - the PR is not linked to an issue;
  - the run did not start (no Docker, no `.env`), and there is nothing to confirm it works with;
  - a mutation gate broke off on a checker crash on the repeat too, or its area was not assembled
    (steps 1–2): nobody checked the PR's mutants;
  - the `comments` gate came with a `.ts` that changes code (step 3): the bug hunt that code needed
    did not run.

Red that is red on the base too does not change the verdict: put it on a separate line as
inherited.

You came to REQUEST_CHANGES on the third run (`K >= 3`) because of a documentation or issue
finding — give BLOCKED instead, and say in "Summary" that a human is needed next. Here BLOCKED
means not "nothing to judge by" but an exhausted round of fixes.

- These grounds are counted over the cumulative diff: `gh pr diff <N>` of step 3 and `files` from
  `gh pr view` of step 4 give the whole branch against the base, not the last push. So a finding
  the author disagreed with comes back word for word on the fifth run too.
- Red is not counted here: it runs on the current head and goes out with the fix, so red on the
  third run is a new breakage, not a round.

## Step 6. PR comment

The verdict goes out as a PR comment. `--no-post` in the arguments — skip this step and just print
the text into the session.

Write the text into a temporary file **outside the repository**, otherwise it gets into the diff.
Publish from the file, so that shell escaping does not mangle the text:

```bash
gh pr comment <N> --body-file <temporary path>
```

- **A new comment on every run, not an edit of the last one.** The history must stay visible whole:
  the `head=<sha>` line shows which commit was green.
- Do not use `--edit-last`: it edits the current user's last comment whatever skill wrote it, and
  would overwrite the `pr-deep-review` verdict.
- Publish exactly the text you printed into the session, with the signature and the marker at the
  end.
- `gh pr comment` failed (no rights, the PR is closed) — print the verdict into the session and say
  that publishing failed and why. Do not keep quiet and do not work around it.
