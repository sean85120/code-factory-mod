## T-001 [feature] Daily puzzle reminder notification
- status: done
- how: Schedule one local notification per day with the system scheduler.
- accept: A reminder fires at the chosen hour and never twice a day.
- tests: Unit tests for the scheduling rules.

## T-002 [feature] Daily puzzle archive without streak inflation
- status: todo
- how: Store solved days in a table and compute streaks from it.
- accept: Replaying an old puzzle never extends the streak.
- tests: Unit tests for the streak rules.

## T-003 [bug] Fix the screens that break in dark mode
- status: todo
- how: Replace hard-coded colors with semantic colors.
- accept: Every screen is readable in light and dark mode.
- tests: Snapshot tests for both modes.

## T-004 [feature] Accessibility pass: reduce motion and Dynamic Type
- status: todo
- how: Honor the reduce-motion setting and scale text with Dynamic Type.
- accept: Animations stop under reduce motion and text scales to the largest size.
- tests: UI tests for both settings.

## T-005 [docs] Write REVIEW.md for the repo
- status: todo
- how: Describe what failure means here and which paths reviewers skip.
- accept: REVIEW.md exists and names the paths to skip.
- tests: None, documentation only.
