#!/usr/bin/env sh
# Cleans up a task worktree after its PR is merged — the counterpart of worktree-init.sh:
# takes the application of this worktree down together with its image and volume, removes
# the worktree itself, the local branch and the branch on origin, and finally fast-forwards
# main in the main worktree.
#
# The moment of cleanup is chosen by a person or an agent who sees the PR merged: until the
# merge the worktree is still needed. The script only makes sure cleaning up is safe by now
# and does all four cleanup steps at once so that none is forgotten — a forgotten one leaves
# garbage that is later read as a task in progress. Two more actions leave no garbage behind,
# and each stands where it does for its own reason, given in its comments: fast-forwarding
# main goes last, updating the shared origin/main goes before the merged check and is repeated
# inside the fast-forward itself, before the ff merge.
set -eu

COMPOSE_FILE="docker-compose.app.yml"
# A ref of its own: the cleanup both checks that the branch is merged and fast-forwards main
# in the main worktree by it. The reason is at the first fetch below.
CLEANUP_REF="refs/worktree-cleanup/main"

die() {
    printf '%s\n' "$*" >&2
    exit 1
}

main_tree() {
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not a git repository: $PWD"
    dirname "$common"
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not a git repository: $PWD"
main=$(main_tree)

[ "$root" != "$main" ] || die "this is the main worktree — cleanup is for a task worktree"

cd "$root"

branch=$(git branch --show-current) || die "could not determine the branch of worktree $root"
[ -n "$branch" ] || die "worktree $root is on a detached HEAD — clean it up by hand once you have dealt with the commits"

changes=$(git status --porcelain)
[ -z "$changes" ] || die "worktree $root has uncommitted changes — the cleanup would destroy them:
$changes"

# Merged is checked before anything else: the other steps are irreversible, and the only
# thing that can be lost here is the branch's commits that main does not have.
# The fetch goes into a ref of its own, not into origin/main: the refs/remotes directory is
# shared by all worktrees of the repository, and a neighbouring session fetching at the same
# moment holds origin/main for writing. Then the objects and FETCH_HEAD arrive but the ref
# write is refused — and the cleanup would stop at a ref it did not need to answer "is the
# branch merged". Hence also --refmap=: without it origin/main is updated along the way,
# whatever the destination ref is called, and the refusal comes back with that update.
# The ref is rewritten by every run (`+` in the refspec) and so is not deleted: deleting it
# is one more command after the irreversible cleanup, and exactly one ref accumulates.
# It is shared too — git has its own per-worktree prefixes (refs/worktree/, refs/bisect/,
# refs/rewritten/), and this one is not among them — so two cleanups running at once
# reproduce the same refusal on a held ref. Its window is of another order: this ref is
# written by two lines of one target, while origin/main was written by any fetch of any
# worktree.
git fetch --quiet --refmap= origin "+refs/heads/main:$CLEANUP_REF" ||
    die "could not fetch main from origin into $CLEANUP_REF — without it there is no way to
make sure branch $branch is merged.
The reason is above: both an unreachable origin and a stuck .lock of the ref itself fail here"
# The cleanup itself no longer needs origin/main, but nobody else keeps it fresh in the main
# worktree: `git worktree add` branches a task worktree off it, and stale_claude in
# scripts/claude-worktree-guard.sh reads it without a fetch of its own — both take whatever
# the last fetch by anyone left. So it is updated here, and by a separate command: asked of
# the same fetch as above, a ref held by a neighbour would again take the cleanup down —
# exactly what separating the refs saves it from.
# The ref brought by the fetch above is copied rather than fetched anew: a second trip to the
# network left a one-round-trip window between it and the first, and a merge landing inside
# that window reached origin/main but not $CLEANUP_REF — the merged check below refused a
# branch the shared ref already showed as merged. The copy removes that mismatch: both refs
# are on the same commit by construction. It does not cancel the refusal itself — a merge
# landing after the fetch above still does not reach $CLEANUP_REF — but then it is not
# visible in origin/main either, and the refusal contradicts nothing. The objects came with
# the same fetch, so origin/main moves to a commit the repository already has.
# It may also move backwards: a newer merge written into it by another fetch between the
# fetch above and this line is pushed back by the copy. The gap is short — there is no
# command between the two lines — and the cost is the same as any staleness of the shared
# ref; the copy at the end of the cleanup or the next fetch by anyone removes it.
# -m: fetch wrote its own reason into the reflog, and update-ref without one leaves an empty
# line.
# The command stands before the merged check, not after: the check aborts the cleanup, and its
# most frequent refusal — a squash merge — must not affect how fresh origin/main is, or the
# next worktree would branch off an old point exactly where the cleanup is finished by hand
# anyway.
# A refusal does not take the cleanup down — it does not need the update — but it does not
# keep quiet either: a ref held by a neighbour passes by itself at the next cleanup, while a
# `.lock` left by a git killed mid-write never does, and git does not remove such files
# itself. A silent refusal does not tell these two cases apart: the second would leave
# origin/main old forever without naming itself — the cleanup would still print "fast-forwarded
# to main on origin" (about main, not about this ref), and the only trace would be an
# `[ahead N]` in the main worktree that does not explain itself.
if ! git update-ref -m "worktree-cleanup: main from origin before the merged check" \
    refs/remotes/origin/main "$CLEANUP_REF"; then
    printf 'origin/main in %s not updated: git update-ref refused,
the reason is above — the cleanup is not affected.
A fetch by a neighbouring session may have held the ref: then the next cleanup updates it.
If the refusal repeats, remove by hand the .lock named in the reason: a killed git left it.\n' \
        "$main" >&2
fi
git merge-base --is-ancestor "$branch" "$CLEANUP_REF" || die "branch $branch is not merged into main on origin — the worktree is still needed.
If the PR was merged with squash (main does not have the branch's commits, only their result),
clean up the worktree by hand:
    git worktree remove '$root' && git branch -D '$branch' && git push origin --delete '$branch'"

# Compose names the image and the volume after the worktree directory, and `git worktree
# remove` does not touch them: once the directory is gone, this target cannot reach them —
# there is nowhere to take the project name from. So they are taken down before the removal,
# and a failure stops the script rather than leaving an orphan silently.
docker compose -f "$COMPOSE_FILE" down --rmi local --volumes ||
    die "could not take down the application of worktree $root — start Docker and repeat: once the directory is removed, this target can no longer remove its image"

cd "$main"

# A message of its own, not a bare `fatal` from git: under `set -e` the refusal would end the
# script silently, without saying that the application with its image and volume is already
# gone. The refusal still aborts the cleanup, unlike the refusals below: there the worktree is
# already gone and the rest is finished by hand, while here it may be intact, and then removing
# its branch and fast-forwarding main would promise a cleanup that did not happen.
if ! git worktree remove "$root"; then
    # remove can also fail halfway: it deletes the contents, unregisters the worktree and only
    # then stumbles on a leftover it could not delete. Such a leftover comes, for example, from
    # coverage or reports: they are mounted from the host (docker-compose.app.yml), the
    # container runs under its own uid (Dockerfile, USER node), and on a Linux host whatever is
    # created in them belongs to it. The uncommitted check above does not see the leftover: both
    # directories are in .gitignore.
    # The worktree is alive exactly when a repeat of the target has somewhere to start from:
    # the script starts from this same toplevel. A comparison, not an exit code: from a
    # directory holding only a leftover rev-parse climbs higher and returns another path.
    if [ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)" = "$root" ]; then
        # About this run, not about the state of main: a neighbouring session that finished
        # its cleanup a minute earlier may have fast-forwarded it, and "left on the commit
        # before the merge" would be a lie.
        # The line breaks are set by the live output, not by the source: absolute paths are
        # substituted into it, and an even source gives a line half as long again as its
        # neighbours.
        die "could not remove worktree $root — the reason is above.
The application of the worktree is down with its image and volume, nothing else is done: the
branch is intact, and this run did not fast-forward main in $main.
Remove the cause and repeat make worktree-cleanup from this worktree: taking down an
application that is already down is harmless.
While the worktree directory is intact, a token pool slot may still be leased to it — a
successful repeat frees it, and the lease also expires by itself: BOT_TOKEN_TTL (2 hours by
default) after the last renewal."
    fi
    # The directory may or may not have survived: remove deletes the contents before the
    # worktree's admin data and may stumble on either. There is no point asking to delete what
    # does not exist, so the line about the leftover stands apart and only while the directory
    # is alive. The caveat about the token pool slot is conditional on the same sign: without
    # the directory the lease cannot hold — lease_alive (scripts/bot-token.sh) requires
    # [ -d "$tree" ] — and there is nothing to say about the slot.
    # Fast-forwarding main in the recipe comes with a caveat about the branch of the main
    # worktree rather than as a ready command, as below: there the branch is already known
    # (git branch --show-current), while here the script never got to it and cannot know what
    # the main worktree will be on when this is read.
    leftover=""
    slot=""
    if [ -d "$root" ]; then
        leftover="    rm -rf '$root'   # git stumbled on it: rm may need the cause dealt with first
"
        # The caveat is glued to the end of the message's last line and carries its own newline
        # in front: were it a separate line, an empty variable would leave an empty line in the
        # output.
        slot="
While the worktree directory is intact, a token pool slot may still be leased to it — the
first line of the recipe frees it; the lease also expires by itself: BOT_TOKEN_TTL (2 hours by
default) after the last renewal."
    fi
    die "worktree $root is not fully removed — the reason is above: git worktree no longer knows it.
The application of the worktree is down with its image and volume. There is nowhere to repeat
the target from — finish the cleanup by hand:
$leftover    cd '$main'
    git branch -D '$branch'
    git push origin --delete '$branch'
    git fetch origin main && git merge --ff-only origin/main
The last line is for a main worktree that is on main. If it is on another branch or on a
detached HEAD, fast-forward without touching what is checked out: git fetch origin main:main —
otherwise merge --ff-only moves what is checked out rather than main, and main stays behind.
The branch may already be gone from origin: GitHub deletes it itself when the PR is merged,
and then push refuses.$slot"
fi

# -D here, not -d: the branch was checked above to be merged into main on origin, and -d does
# not trust proof from there — it counts a branch as merged only by HEAD and the upstream, and
# in the normal course of work both miss. The local main of the main worktree lags behind
# (this same script fast-forwards it, but further down), and the upstream after `push -u` is
# origin/<branch>, which GitHub deletes itself when the PR is merged.
# The refusal is a condition, not the script body: in the body set -e would catch it and
# abort the cleanup after the irreversible steps, and with it the summary line, the main
# fast-forward and the cd hint — while the session's directory no longer exists by then.
branch_left=""
if git branch -D "$branch"; then
    branch_where="deleted locally"
else
    # About the outcome of the command, not the state of the branch: the script did not check
    # the state — unlike origin below, where there is ls-remote — and a refusal of branch -D
    # covers both "could not delete" and "nothing to delete": both outcomes exit with 1.
    branch_where="not deleted locally"
    branch_left=1
    # The directory of this worktree is already gone, and the caller has nowhere to run the
    # command: the cd hint comes only at the end, and until then the shell sits in a directory
    # that does not exist.
    printf "could not delete branch %s, the reason is above.\nDelete it yourself from the main worktree: cd '%s' && git branch -D '%s'\n" \
        "$branch" "$main" "$branch" >&2
fi

# The branch may already be gone from origin: GitHub can delete it itself when the PR is merged.
# The full ref name is asked for: an ls-remote pattern matches the tail of a name at a slash
# boundary, so "$branch" would also find another branch "something/$branch", and push would
# then refuse about a branch origin never had.
# The exit code is captured into a variable rather than tested with `if !`: ls-remote tells
# "no such branch" (2) from "could not ask" (128 — no network, no access, the host does not
# resolve) only by it, and `if !` equates these outcomes and passes an unreachable origin off
# as a missing branch. The window between the network check further up and this line is tens
# of seconds of image removal. For the same reason stderr is not silenced: git names the
# reason itself.
origin_left=""
listed=0
git ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null || listed=$?
if [ "$listed" -eq 2 ]; then
    origin_where="already gone from origin"
elif [ "$listed" -ne 0 ]; then
    # About the outcome of the command, not the state of the branch, for the reason in the
    # comment at branch -D above: here the state is not checked either — that is exactly what
    # could not be done.
    origin_where="not checked on origin"
    origin_left=1
    # The hint starts with cd for the reason in the comment at the same hint above.
    # It does not ask for a separate check, although the outcome is precisely unchecked: push
    # itself answers "is the branch still there", and an extra ls-remote by hand adds nothing
    # to it. Instead the hint sorts push refusals by message, not wholesale: an unreachable
    # origin leads here, and it is also the likeliest cause of the next refusal, so "push
    # refuses — hence no branch" would pass an unreachable network off as cleaned up.
    # A refusal because the branch is missing is, on the contrary, a normal outcome: GitHub
    # deletes it when the PR is merged (comment above), and the hint cannot leave it unnamed,
    # or whoever follows it reads "remote ref does not exist" as an unfinished cleanup. Other
    # refusals the hint does not turn into "the branch is intact", for the reason in the
    # comment at branch -D above: the state of the branch stays unchecked here — it is the
    # very thing that checks it that refused. Hence it speaks of origin, not of the whole
    # cleanup: the local branch may have been left undeleted by its own refusal above.
    printf "could not check branch %s on origin, the reason is above.
Deal with it yourself from the main worktree: cd '%s' && git push origin --delete '%s'
A \"remote ref does not exist\" refusal means the branch is already gone from origin: GitHub
deletes it when the PR is merged, and everything on origin is cleaned up. A refusal for any
other reason — most likely the same one that prevented the check — says nothing about the
branch: repeat the command once the cause is removed.\n" \
        "$branch" "$main" "$branch" >&2
# The push refusal is a condition, not the body of the if, for the reason in the comment at
# branch -D above. Its own are the causes of refusal unrelated to the state of the worktree:
# the network, access, someone deleting the branch between ls-remote and push.
elif git push origin --delete "$branch"; then
    origin_where="deleted on origin"
else
    # About the outcome of the command, not the state of the branch, for the reason in the
    # comment at branch -D above; here the race from the comment over push adds to it: in that
    # race push refuses precisely because the branch is already gone from origin.
    origin_where="not deleted on origin"
    origin_left=1
    # The hint starts with cd for the reason in the comment at the same hint above.
    printf "could not delete branch %s on origin, the reason is above.\nDelete it yourself from the main worktree: cd '%s' && git push origin --delete '%s'\n" \
        "$branch" "$main" "$branch" >&2
fi

# "cleaned up" refers to the worktree, not to the list after it: the branch may be undeleted
# in both slots, and a common "cleaned up: …" would head two negatives.
printf 'worktree %s cleaned up; branch %s: %s, %s\n' "$root" "$branch" "$branch_where" "$origin_where"

# The local main in the main worktree still sits on the commit before the merge: nobody else
# fast-forwards it, and a session starts right there and reads the code and the docs from it
# until it creates its own worktree. This is the only moment that knows both "the PR is
# merged" and the path of the main worktree. The cleanup above is already irreversible, so a
# failed fast-forward only warns: there is no reason to fail the target, its whole job is done.
# --ff-only only: a diverged main means commits made right in the main worktree, and those
# must not be glued in silently.
# Git refusals below do not take the script down for the same reason: failing would swallow
# the cd hint, and the cleanup is already done.
# The hint is one for both refusals, because fast-forwarding is fetch and merge together,
# whichever refusal led here: a merge alone would reach only the ref fetched during the
# cleanup — the very staleness the fetch below is there for. It starts with cd for the reason
# in the comment at the same hints above.
# The hint goes through origin/main, although the script itself does not: it is run by hand
# and later, when another fetch has already released the shared ref.
retry="Remove the cause and fast-forward main from the main worktree — the task worktree cleanup is already done:
    cd '$main' && git fetch origin main && git merge --ff-only origin/main"

current=$(git branch --show-current) || current=""
if [ "$current" != "main" ]; then
    if [ -n "$current" ]; then
        on="is on branch $current"
    else
        on="is not on branch main"
    fi
    # The hint is fetch, not merge: merge --ff-only on another branch would move that branch,
    # and on a detached HEAD it would move HEAD and leave main behind — doing exactly what
    # this branch of the if guards against. fetch updates main without touching what is
    # checked out, and refuses if they diverged.
    printf 'main in %s not fast-forwarded: the main worktree %s, and the branch there is not switched.\nTo fast-forward without touching the checked-out branch: git fetch origin main:main\n' \
        "$main" "$on" >&2
# The fetch is repeated, and the trip to the network with it: between the one at the merged
# check and this line lie the image removal and the removal of the worktree, the local branch
# and the branch on origin — tens of seconds in which a neighbouring session manages to merge
# its PR. On a stale ref the merge would report success and leave main behind.
# The ref and --refmap= are the same as at the merged check, for the same reason: see the
# comment there.
elif ! git fetch --quiet --refmap= origin "+refs/heads/main:$CLEANUP_REF"; then
    printf 'main in %s not fast-forwarded: git fetch refused, the reason is above.\n%s\n' "$main" "$retry" >&2
else
    # The copy is repeated from the fresh ref: the first one stayed on the commit the cleanup
    # started at, and the trailing fetch above brought what origin has now. Without it
    # origin/main would lag behind the fast-forwarded main by the whole span of the cleanup —
    # that very `[ahead N]` in git status -sb — while the copy needs no network any more.
    # It stands before the ff merge, not in the branch of its success: how fresh the ref is
    # does not depend on the merge outcome, and after a failed merge origin/main would stay on
    # the commit the cleanup started at — missing other merges that landed in its tens of
    # seconds, and the next task worktree would branch off past them. The refusal itself
    # speaks only of main, so nobody would name the stale origin/main.
    # The gap in which another fetch manages to write a newer merge into the shared ref, for
    # the copy to push it back, is the same here as at the first copy: there is no command
    # between the fetch and the write.
    # A refusal here keeps quiet, unlike at the first copy: it can only be about a ref held by
    # a neighbour between the two copies — a stuck .lock would have failed the first one too,
    # with its message. One left between them is named by the first copy of the next cleanup,
    # and until then the cost is exactly what it was before this line: origin/main on the
    # commit the cleanup started at.
    git update-ref -m "worktree-cleanup: main from origin after the cleanup" \
        refs/remotes/origin/main "$CLEANUP_REF" 2>/dev/null || true
    if git merge --ff-only --quiet "$CLEANUP_REF"; then
        # "to main on origin", not "to origin/main": the local origin/main may have stayed
        # unrewritten — the copy above keeps quiet about a refusal.
        printf 'main in %s fast-forwarded to main on origin\n' "$main"
    else
        # To stderr, like die() and git itself: otherwise "the reason is above" promises a line
        # the stream being read does not have.
        printf 'main in %s not fast-forwarded: git merge --ff-only refused, the reason is above.\n%s\n' "$main" "$retry" >&2
    fi
fi

printf "the session's current directory is removed — go to the main worktree: cd '%s'\n" "$main"

# The non-zero code tells these outcomes from a full cleanup: the rest of the branch is
# finished by hand, and the output is not always read to the end. It does not differ from the
# codes of die() — how much of the cleanup is done only the output says: die() above happens
# both before the first irreversible step and after the image and volume are removed.
[ -z "$branch_left$origin_left" ] || exit 1
