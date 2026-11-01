# User review — the `user:review` step

The user reviews and tests the work by hand. The work is in the working tree of each repo of Repos touched and each repo that a `Dev notes:` comment added, on the branch `<TAG>-<n>`, with no commits. A fix goes through `dev:implement`, so that the review and the tests run again: this step changes no file in the repos.

## The briefing

Send one message. Its sources are the task body (the spec), the comments (`Dev notes:`, the last `Review #N: PASS`, the `dev:test` report) and `git -C <repo> status --short`. It has five parts:

1. **What the task does**: 1 or 2 sentences.
2. **What changed**: for each repo, the branch and the main changes in behavior. Each deviation of `Dev notes:` is in this list.
3. **Where to see it**: the command that starts the app and the address, from the `dev:test` report, or from the project when there is no report.
4. **What to try**: numbered steps. The smoke checks of the spec first, then the cases that the review or the test raised.
5. **What was not checked**: from the `dev:test` report, for example "the screen was not checked". When there is no `dev:test` report (the step was skipped), say so.

Then ask the user to review and test by hand, and wait. This is a review gate (see *Human checkpoints are conversations* in the workflow instructions).

## The exits

- **Approval**, explicit and quotable: a comment `user:review` with `Approved by the user: "<quote>"`, the repos and the branch, and "Nothing is committed." Set the step `dev:integrate` and start its chat.
- **Problems**: a comment `user:review` with each problem as a numbered item: the words of the user, then what the agent found (the file, the steps to see it). That comment is the only context of the next chat. Set the step `dev:implement` and start its chat.
