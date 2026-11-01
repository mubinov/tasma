# Review — the `dev:review` step

Review the work of `dev:implement` and route it to `dev:test` or back to `dev:implement`. The step is read-only (see *Git* in the workflow instructions) and fixes nothing. The pass or fail is the judgment of the agent, and the step asks the user nothing. It stops for the user only on a repo on the wrong branch, a reviewer that still fails after its restarts, and the loop limit.

## What it reviews

For each repo of Repos touched and each repo that a `Dev notes:` comment added:

```
git -C <repo> branch --show-current
git -C <repo> diff HEAD
git -C <repo> ls-files --others --exclude-standard
```

- The work has no commits before `dev:integrate`, so no base branch is needed.
- Untracked files are part of the change, except the files under `.specs/`.
- In a repo with no commit, `git diff HEAD` fails. Skip it: `git -C <repo> ls-files --cached --others --exclude-standard` lists the whole change.
- When a repo is not on `<TAG>-<n>`, stop. The hand-off is `# Stopped: dev:review`, with no next chat, and `# REQUIRED FROM USER` tells the user to put the repo on the branch and run the step again. This check does not apply to a repo for which the task body or a comment records the approval of the user to skip `dev:setup` or to keep the repo on another branch.

## The review number

Count the earlier `## Review #N:` comments of the task and add 1.

## The reviewers

Parallel subagents, at the level that the table names (see *Model levels of review subagents* in the workflow instructions). The table of [Routing](#routing) tells which reviewers run on which review.

| Reviewer | Level | Focus |
|---|---|---|
| Deep | Top | Subtle logic bugs, race conditions, problems across files, security and performance that need a trace through several files |
| Pragmatic + Linters | Standard | Rules of the project, missing error handling, silent failures, names. Runs the linters of the project and keeps only the errors in changed files, in the same list, with the label `[lint: <rule>]`: 🔵 for a style rule, 🟡 for a type error or a rule that shows a real bug |
| Test Coverage | Standard | Runs the tests, with coverage when the project has a tool for it. Compares the changed lines with the coverage. An uncovered changed line is a finding with the label `[coverage]`: 🟡 for logic, 🔵 for a trivial line. By the test rule below, a failing test has the label `[test-fail]` and 🔴, and any other failure has the label `[test-other]` and 🟡 |
| Security | Top | Only security. Traces untrusted input from where it enters to where it is used: injection, XSS, access checks, secrets, weak crypto or randomness, unsafe deserialization, SSRF, path traversal, risky new dependencies, CSRF, CORS, open redirects. States how an attacker triggers each finding. 🔴 for an exploitable problem, 🟡 for hardening. Label `[security]` |
| Architecture | Top | The design, not single lines: layers, coupling, fit with the patterns of the project, abstractions, where state lives, public interfaces, what is hard to change later. 🔴 for a design that breaks correctness or a shared contract, 🟡 for maintainability, 🔵 for a small inconsistency. Label `[arch]` |
| Accessibility | Top | Runs only when the change touches frontend files. WCAG AA: semantics, name, role and value, keyboard and focus, media alternatives, form labels and errors, contrast and color-only meaning, live regions. Each finding names the success criterion. 🔴 only for a blocker or a clear AA failure. Label `[a11y: <criterion>]` |
| Style | Top | What a linter cannot judge: long files and functions, unclear names, wrong file placement, duplicated blocks, dead code, comments that repeat the code, argue or tell a story instead of stating a fact, or name a test, a past or future task or a review round. A comment is only for a constraint that the code cannot show, as short as that constraint allows. Drafts each "extract a function" first and reports it only when the result is clearly simpler. Always 🔵. Label `[style]` |

**Each reviewer:**

- gets the spec (the task body), the `Dev notes:` comments, and the commands of [What it reviews](#what-it-reviews);
- reads each substantially changed file in full, and the rule files of the project and of the user;
- reports only problems that this change caused and that it verified in the code (`[test-other]` of the test rule is the one exception), and reads the source of a framework when a finding depends on how the framework works;
- skips formatting, "you could also do X", hypothetical problems and praise, and reports duplication only when a concrete extraction is simpler;
- prefers a rename, a type or a test over a comment as a fix;
- uses the severities 🔴 High (correctness, security, data loss, crash), 🟡 Medium (a real bug on an edge case, a performance regression, an unhandled error, a test gap on logic), 🔵 Low (convention, name, small refactor);
- returns a numbered list, each item with the severity and a one-line title, `file:line`, the problem and its effect in 2 to 4 sentences, and `Fix:` with the direction, or `No issues found.`;
- deletes nothing, and names in its result each file that its run made, for example a coverage report.

**Cleanup.** Reviewers share one working tree, so only the main chat cleans up. Save `git -C <repo> status --short -uall` before the first reviewer starts. After the last reviewer ends, compare the status with that list and delete, by name, only the new files that the reviewers named. A tracked file that a run changed stays, and the note names it as a side effect of the run.

**On a re-review,** each reviewer also gets the earlier `Review #N:` notes and the `Review response:` comments. It confirms that each earlier finding is resolved in the current diff. It repeats a rebutted finding only when it can prove the rebuttal wrong with reasons.

**The test rule.** A failing test runs again alone. It is a `[test-fail]` finding only when it fails again and it reaches code that the change touched. Test Coverage reports any other failure as `[test-other]`, also when this change did not cause it. The main chat moves it to a follow-up task, and it does not route this task.

**No tooling.** When the project has no tests or no coverage tool, this is one line in the note and not a finding, because `dev:implement` adds no test setup, so such a finding could never be resolved.

**A reviewer that fails.** A reviewer succeeds only when it returns a list or `No issues found.`. Restart a reviewer that ends in an error or an empty result, with the same prompt, at most 2 times. Never guess its findings. Do not start the judge until each reviewer of the round has succeeded. When a reviewer still fails, stop and tell the user: the hand-off is `# Stopped: dev:review`, with no next chat. When the user tells the same chat to continue, restart only the reviewers that did not succeed. A new chat runs all reviewers of the round.

## The judge

The main chat. For each finding, read the file and line and confirm the problem. Discard what you cannot confirm.

- A finding from 2 or more reviewers is probably real, and it still gets the check.
- When reviewers disagree, read the code and decide.
- Merge findings with the same file, an overlapping range and the same cause, and keep the stricter severity.
- Set the final severity from the code, not from the claim of the reviewer.
- Keep a `[lint: ...]` finding when it is in a changed file. Do not judge the style rule again.
- Keep a `[test-other]` finding: the run of the reviewer is the proof.
- Merge `[test-other]` findings with the same cause into one finding, also across files.
- Give `[security]`, `[arch]` and `[a11y: ...]` findings high priority, and check them the same way.
- Collapse many uncovered lines of one file into one finding.
- Write out each "extract a function" finding. Keep it only when the result is clearly simpler. Otherwise discard it: repetition is sometimes the correct design.
- At most 30 findings. When more exist, the note says how many low findings it left out.
- Drop a repeated rebutted finding when the reviewer did not prove the rebuttal wrong.

## Routing

| Review | Reviewers | FAIL when | Otherwise |
|---|---|---|---|
| 1 | All 7 (Accessibility only with frontend changes) | Any finding at any severity | PASS |
| 2 | Deep, Security, Accessibility (only with frontend changes), Style | Any 🔴, any 🟡, any non-cosmetic 🔵 | Only cosmetic 🔵: PASS by default, and FAIL only when the chat judges the whole set worth a cleanup. No fixed count. No finding: PASS |
| 3 or later | Deep, plus Security when the change touches backend code | Any 🔴, or a 🟡 that is a real production defect: wrong runtime behavior, data loss, a crash or a security hole on a production code path | PASS. All other findings are deferred. When in doubt whether a 🟡 is a production defect, it is not |

**Cosmetic 🔵:** the fix changes no runtime behavior, removes no failure, also no rare one, and gives no clear maintainability gain. When in doubt, it is cosmetic. 🔴 and 🟡 are never cosmetic. The chat decides this after the judge.

**Move a finding out** before the routing, in these cases:

- this task did not cause the problem;
- this task caused it, but the fix needs 3 or more files outside the diff;
- it is real, but it is not the goal of this task;
- it has the label `[test-other]`.

Create the follow-up task yourself, with no approval:

- The title starts with `[AI]`.
- The status is the not-ready status of the project.
- The body holds `Follow-up of <TAG>-<n>`, the line "Written by an AI from a review finding. No human read it. Verify the finding before any work.", and the finding: `file:line`, what fails, why it moved out.
- First read the comments of the task. Never open a second task for the same finding: name the existing id.

Moved findings do not route this task. A round where all findings moved out is a PASS.

## The note

The title of the comment is the step name, with the round number from the second review on. The body starts with `## Review #N: PASS` or `## Review #N: FAIL`, and it holds what the next chat must act on:

- the counts by severity and the routing;
- every finding that the judge kept, and each moved finding with its task id;
- each deferred finding written out, because the note is the only place from which a later `dev:implement` can read it;
- the findings that the judge discarded, one line each, so that no one raises them again;
- the checks that ran, one line. A failed check is a finding.

No scorecard per reviewer. No list of areas that had no findings.

## The exits

- **PASS:** set `dev:test` and start its chat.
- **FAIL:** set `dev:implement` and start its chat. Do not fix anything in this chat.
- **FAIL on review 15 or later:** write the note and set `dev:implement`, but start no chat. `# REQUIRED FROM USER` lists each blocking finding, which of them repeat across the earlier notes, what each round tried, and why the loop does not end.

A deferred finding is not lost and does not route: a later `dev:implement` handles it only when a later step sends the task back. When the task ships without that, the finding ships too.
