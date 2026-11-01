# Test — the `dev:test` step

The step runs after `dev:review` passes: it runs the tests, checks the function and sends the task to `user:review`.

## Find the commands

Look in this order, and ask the user when you find nothing:

1. the rule files of the project;
2. `README` and contributing docs;
3. config files, for example `package.json`, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`;
4. CI config.

## Before the first run

Save `git -C <repo> status --short -uall` for each repo.

**Real data.** Never test against real data or a production service. Follow the rules of the project for its development environment.

## Three checks, in this order

Skip a check that does not fit the project or the change, and say so in the report.

1. **Automated tests**, the fastest check first.
   - Fix an out-of-date test where it is.
   - A failure that needs a code change is a defect: go back to `dev:implement`, and do no manual test on a build that is already broken.
   - A failing test runs again alone. It is a defect only when it fails again and it reaches code that the change touched. Any other failure goes to a follow-up task and does not route this task. Failures with the same cause go to one task, also across files. Create the task with no approval, after you read the comments of the task, so that you open no second task for the same failure:
     - The title starts with `[AI]`.
     - The status is the not-ready status of the project.
     - The body holds `Follow-up of <TAG>-<n>`, the line "Written by an AI. No human read it. Verify the problem before any work.", then `file:line`, what fails and why it is outside this task.
2. **Backend,** only when the project has one and the change touches it. A suite that passes often proves only the logic with mocks, so use the running service. Start it when it is not running.
   - Send real requests and compare the status, the shape and the values with the spec.
   - Read the stored records and compare them with the spec.
   - Try the error and edge cases of the spec.
3. **Screen,** only when the project has a UI, the change reaches the screen, and the agent has a browser tool. With no browser tool, the report says "the screen was not checked". Start the dev server when it is not running, and reuse a running one.
   - **Function:** the actions of the spec work, the content shows, the flow ends, the console has no errors, the edge cases work. Read stored client data back and compare it with the spec.
   - **Look:** a screenshot at each width that the project supports, and read each screenshot: overflow, anything cut off, overlap, wrong stacking, wrong order or alignment, wrapped or clipped text, wrong icon size, broken spacing, images that do not load. Look at the rest of the page too.
   - **States and layers:** one screen in its default state is not the check. See each state of each control that the change touched: hover, keyboard focus, selected, disabled, loading, error, empty. Reading a computed style is not looking. Open each dialog, drawer, menu, overlay and toast that the screen can open, at each width, also the ones that the change did not add.
   - **Design:** when a design file exists, put it next to the screenshot and judge them side by side.

## Cleanup

Compare the status with the saved list and delete, by name, only the files that the run made. Do not use `git clean` or `git restore`, and do not change `.gitignore`. A tracked file that the run changed, for example a snapshot, stays, and the comment names it. Stop each process that the step started.

## The `dev:test` comment

It holds what `user:review` reads:

- the commands and their results;
- the command that starts the app, and its address;
- what was checked;
- what was not checked;
- the cases that the test raised, for the user to try;
- the test files that the step fixed, as files of the task;
- the tracked files that the run changed, marked as side effects of the run, so that `dev:integrate` asks about them;
- the follow-up tasks that the step opened.

## The exits

- **Success:** set `user:review` and start its chat.
- **Failure:** add the `dev:test` comment, with the failure first, set `dev:implement` and start its chat.
- **Round limit.** When the task has 15 or more `## Review #N:` comments, a failure sets `dev:implement` and starts no chat, and `# REQUIRED FROM USER` lists the failure. The review loop limit applies only to a review FAIL, and from review 3 a review passes unless it finds a production defect, so the `dev:test` loop needs its own stop.
