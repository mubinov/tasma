# Implement — the `dev:implement` step

Implement the approved spec, or handle the findings that sent the task back. Then go to `dev:review`.

## On entry

1. Find the round number N: the highest `#N` of the `Dev notes #N` comments plus 1, or 1 when there is none.
2. Run `git -C <repo> branch --show-current` for each repo of Repos touched and each repo that a `Dev notes:` comment added. When a repo is not on `<TAG>-<n>`, stop before any change. The hand-off is `# Stopped: dev:implement`, with no next chat, and `# REQUIRED FROM USER` tells the user to put the repo on the branch and run the step again. This check does not apply to a repo for which the task body or a comment records the approval of the user to skip `dev:setup` or to keep the repo on another branch.
3. A repo that Repos touched missed gets its branch by rule 1 of *Git* in the workflow instructions. Before that branch, stop and ask the user when the path is not a git repo, when `<TAG>-<n>` exists but another branch is checked out, when no branch is checked out (detached HEAD), when the repo is on another `<TAG>-*` branch, or when the repo has uncommitted changes outside `.specs/`. A repo already on `<TAG>-<n>` needs nothing. Quote the answer of the user in `Dev notes #N`. When the answer ends the step, the hand-off is `# Stopped: dev:implement`, with no next chat, and the step stays `dev:implement`.

## The work

- **Test order.** Logic (pure functions, data transforms, data flow, validation): the failing test first. UI components: the code first, the tests after it.
- **Coverage.** Each changed line has a test at the end of each round, also each defensive guard and each reject path. A fix adds lines that also need tests. `Dev notes #N` reports the coverage in one line and names each uncovered line with the reason. No table per file. No second report of a line that an earlier round already reported.
- **No test setup.** When the project has no tests or no coverage tool, `Dev notes #N` says so. The step adds no test setup unless the spec asks for it.
- **Docs.** On each round, the docs that the change touches match the code. State each doc as the code is now, with no story of the edit.
- **Code comments.** A comment holds only what the code cannot show: a constraint, a known failure mode, a domain rule, as a fact about the code as it is now. Delete a comment that repeats the code, explains common library knowledge, justifies a test, names a past or future task, or explains a review fix. Do not copy text of the spec into the code. On each round, read each comment of the diff against this rule.
- **Deviations.** Each difference from the spec goes in `Dev notes #N`: what changed and why.
- **Problems outside the task.** A problem that the chat finds and that is outside the spec and the findings goes to a follow-up task and is not fixed here. Problems with the same cause go to one task, also across files. Create the task with no approval, after you read the comments of the task, so that you open no second task for the same problem:
  - The title starts with `[AI]`.
  - The status is the not-ready status of the project.
  - The body holds `Follow-up of <TAG>-<n>`, the line "Written by an AI. No human read it. Verify the problem before any work.", then `file:line`, what fails and why it is outside this task.

## When the task comes back

- **A finding of a `Review #N:` note.** A finding is not an order. Check it against the code before any change, in both directions: do not agree because the reviewer is sure, and do not reject because the fix is hard.
  - Agree: fix it with the same test order, and write one line in the notes: `#3 fixed — <what changed> (test: <name>)`. Do not repeat the title, the place or the mechanism of the finding. When the finding is one case of a wider kind of failure, fix the kind.
  - Disagree: a comment `Review response:` with a concrete reason: the code path that makes it unreachable, the spec line that makes it intentional, the test that proves the behavior. "Won't fix" is not a reason.
  - Each finding ends fixed, rebutted or in the stop of the next line.
  - When the spec does not decide it and the chat is not sure, do not guess. Handle the other findings, add `Dev notes #N`, and write this finding and the open decision in a `Review response:` comment. The hand-off is `# Stopped: dev:implement`, with no next chat, and `# REQUIRED FROM USER` names the decision. The step stays `dev:implement`, and the next round acts on the answer of the user and quotes it in its notes.
- **A repeated finding.** Read the earlier `Review #N:` notes. When a finding of the same kind occurs again, the earlier fix was too narrow: close the whole kind in one pass.
- **Deferred findings.** When the last `Review #N:` note is a PASS that lists them, handle them in this round with the same agree-or-rebut process. A later step sent the task back, so this is the only place where they get fixed.
- **A problem from `dev:test` or `user:review`.** Fix it. When the chat cannot reproduce the problem, it asks the user and does not argue against it.

## End of the step

Add a comment with the title `Dev notes #N` and a body that starts with `Dev notes:`. This is the `Dev notes:` comment that the workflow instructions name and that `user:review` and `dev:integrate` read. It names each repo that the step added and each follow-up task that the step opened. Set `dev:review` and start its chat.
