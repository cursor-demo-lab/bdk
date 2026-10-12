# Jev triage eval: results

## After merging main (#178 squash-merged as 6679113)

The older numbers further down were measured at 72c5241, before this branch merged main. The merge takes #178's final severity rule as it is: `calibrateSeverity` only lowers, caps only on clear evidence, and otherwise keeps Jev's severity. A loss or critical phrase means no cap for any type; a question is at most low; a Story, Task, or feedback at most medium; a Bug is capped to medium only on typed-input, UI-widget-cosmetic or feature-request evidence. This branch's separate rework of that rule (`formInputLoss`, the payee/contact nouns) was dropped. Jev's questions (type, severity, and gate wording) and the type guard are unchanged by the merge, so type accuracy, clear-bug Stories, and fallback are unaffected.

What changes is the host cap on severity, checked offline over all 104 cases with each case's expected type:
- 47 Bug cases (39 tune, 8 holdout) were capped at medium before and now keep Jev's severity, since their text has no evidence the guard knows.
- 2 holdout cases (`h-undo-removed-payee`, a Story; `h-deleted-payees-retention`, a Task) are now capped at medium by their type. Both labels are low or medium.
- No case's expected or accepted severity is out of reach of the new ceiling.

Severity accuracy therefore now rests on Jev's own answer for most Bugs. Re-measured live at a44946a (#179) with `npm run eval:jev-triage`:

| Split | Type (lenient / strict) | Severity (lenient / strict) | Fallback |
| --- | --- | --- | --- |
| Tune | 100% / 99.6% | 100% / 81.0% | 2.4% |
| Holdout | 100% / 90% | 100% / 80% | 0% |

Recorded 2026-09-28 (AEST) with `npm run eval:jev-triage`, against live TypeSafe with TLSSN's types (Task, Story, Bug).

- **How each case runs:** 3 times through the real `triageIntake`. The improvement loop used 6 runs.
- **Lenient vs strict type accuracy:** lenient also accepts a case's listed defensible alternates (`accept`); strict does not.
- **Severity:** what the desk files, after the host's severity guard.

**What is compared:**
- `main` at 63791c9, run before the label check (see below). Its lenient numbers are unaffected by the label changes; its strict severity is.
- #178 at 9f892e4 (the severity calibration), run with the current labels.
- This PR ("final", measured at 72c5241, the head after the last review fixes and #178's latest merge; the earlier 3295f0d run is noted where it differs). It includes the sharpened `ISSUE_TYPE_CRITERIA`, the type guard, and the judge-driven severity and gate wording. Its payee/contact data-loss rework was dropped when the branch merged main (see "After merging main").

## Tune split (84 cases, 252 calls)

| | main | #178 | final |
| --- | ---: | ---: | ---: |
| Type accuracy, lenient / strict | 93.3% / 86.1% | 94.0% / 86.9% | **100% / 98.8%** |
| Clear bugs typed Story | 17 of 114 | 15 of 114 | **0 of 114** |
| Severity accuracy, lenient (strict) | 93.3% | 97.6% (76.2%) | **100% (79.8%)** |
| Fallback to the model | 9.1% | 11.5% | **4.0%** (2.8% at 3295f0d) |

Type confusion (rows are the expected type; each cell lists Jev's answers as Bug / Story / Task):

| expected | #178 | final |
| --- | --- | --- |
| Bug | 117 / 24 / 0 | 141 / 0 / 0 |
| Story | 6 / 66 / 0 | 3 / 69 / 0 |
| Task | 0 / 3 / 36 | 0 / 0 / 39 |

The three Story → Bug runs in the final column come from one case whose `accept` lists Bug.

**Run-to-run variance in fallback:** fallback is Jev's lowest answer at or under 0.52, and the same few borderline cases (`needs-info-transfer-feels-wrong`, `sol-negative-after-transfer`, `recurring-transfers`, `modal-click-outside-wipes`) flip either side of the bar between runs. Across the 3295f0d run, the r3 loop run (6 runs), a run at 01d796b and the final run at 72c5241, tune fallback was 2.8%, 4.0%, 6.0% and 4.0%. The review fixes since 3295f0d touch only the host's severity and type guards, not what Jev is asked.

Baseline misses now fixed:
- **Typed Story on #178** (all are Bugs):
  - TLSSN-43 (the reference note isn't shown, then "could the confirmation show it?")
  - default account ignored
  - statement debits with no minus sign
  - frozen card still in the active list
  - case-sensitive payee search
  - sideways profile photo
- **Severity:**
  - `badge-count-stuck` (medium → low)
  - `restore-wiped-real-payees` (medium → urgent)

## Holdout split (20 cases, 60 calls; frozen, never shown to the judge, but used by the loop's keep rule)

| | main | #178 | final |
| --- | ---: | ---: | ---: |
| Type accuracy, lenient / strict | 100% / 94.9% | 100% / 95.0% | 100% / 90.0% |
| Clear bugs typed Story | 0 | 0 | 0 |
| Severity accuracy, lenient (strict) | 94.9% | 90.0% (68.3%) | **100% (80.0%)** |
| Fallback to the model | 23.3% (one TypeSafe outage) | 11.7% | **1.7%** |

Type confusion (Bug / Story / Task, as above):

| expected | #178 | final |
| --- | --- | --- |
| Bug | 30 / 3 / 0 | 30 / 3 / 0 |
| Story | 0 / 18 / 0 | 0 / 18 / 0 |
| Task | 0 / 0 / 9 | 3 / 0 / 6 |

- **Bug → Story ×3 on every version:** `h-refresh-lost-payee-entry` (a page refresh loses a half-typed payee; `accept` lists Story).
- **Final Task → Bug ×3 (×2 at 3295f0d):** `h-payees-index-check` (a "can you check the index?" chore; `accept` lists Bug).
- **#178 severity misses:** `h-migration-deleted-payees` and `h-contacts-vanished` were filed medium. Both were filed urgent in the final run. After merging main, #178's loss patterns ("my payees were deleted", "all my contacts vanished") read both as loss, so neither is capped.

How to read the holdout: it came out easier than intended, since both baselines score 100% lenient type on it. So it confirms there is no regression on fresh wording rather than proving the type gain. The strict type drift (95.0% → 90.0%) is one ambiguous case moving to an accepted alternate.

**Caveat: the holdout is not a clean holdout for the loop.** Its cases and labels were never edited and the judge never saw them, but the improvement loop's keep rule read holdout metrics, and r2 was tried because of a holdout dip. The final holdout numbers are therefore partly a selection result. Treat them as a no-regression check; a fresh holdout is needed to claim generalisation.

## Bug/Task only (the desk's types when the project list can't be read; all 104 cases)

| | #178 | final |
| --- | ---: | ---: |
| Type accuracy, lenient / strict | 99.7% / 94.9% | 99.0% / 96.2% |
| Severity accuracy | 96.2% | 100% |
| Fallback to the model | 11.5% | 2.9% |

The one lenient miss is holdout `h-session-too-short` ("the session times out too fast"). With Story not offered it is typed Bug where Task was expected. #178 also typed it Bug once. It is left as is, because it is a holdout case.

## LLM judge (`--judge`: Claude Opus 5.5, low effort, through `@cursor/sdk`)

### Label check

The judge labels every case blind, from the reporter's words and a neutral policy written separately from Jev's question and our tie-breakers.

| Agreement with the hand labels | Strict | Lenient |
| --- | ---: | ---: |
| Type, first run (case ids visible) | 96.2% | 100% |
| Severity, first run (case ids visible) | 83.7% | 100% |
| Type, after the label fixes, truly blind | 95.2% | 100% |
| Severity, after the label fixes, truly blind | 84.6% | 100% |

- **Hard disagreements:** none. In every case, the judge's answer was inside our accepted set or ours was inside its defensible set.
- **Case ids:** the first runs sent case ids such as `needs-info-…`, which hint at the answer. The review caught this, and the prompt now numbers the cases `c1…cN`. The truly blind rerun still found no hard disagreement.
- **Run-to-run variance:** strict agreement moves by a few points between runs.

**Labels changed.** Five tune cases had their primary severity changed from low to medium, with low still accepted. The rubric makes "broken or wrong with a workaround" medium. The judge said medium, and Jev filed medium.
- `default-account-ignored`
- `payee-search-case-sensitive`
- `confirmation-shows-yesterday`
- `renamed-payee-old-name-review`
- `reports-range-resets`

**Labels kept despite a soft disagreement:**
- TLSSN-43 stays Bug. It is the report this work exists to fix, and the judge accepts Bug as an alternate.
- `transfer-pending-hour-question` stays Bug, per the tie-breaker that a question about a specific failure is a bug.
- `rename-token-register` stays Task, since a rename is a chore.
- No holdout label changed, so its hash is unchanged.

### Improvement loop

The judge critiqued every tune miss and every answer at or under 0.52 (holdout cases are never shown to it), then merged the suggestions that generalise.
- **How each round was scored:** 6 runs per case on tune and on holdout.
- **Keep rule:** a round was kept only if the holdout's lenient type and severity, its clear-bug count, and its fallback rate did not get worse.

| Round | Change | Tune: type (strict) / severity (strict) / fallback | Holdout: type (strict) / severity (strict) / fallback | Kept |
| --- | --- | --- | --- | --- |
| r0 | Before the judge (labels fixed) | 100% (99.2%) / 98.8% (76.8%) / 11.9% | 100% (90.0%) / 100% (82.5%) / 5.8% | baseline |
| r1 | Severity wording (below) | 100% (99.6%) / 100% (79.7%) / 7.9% | 100% (90.0%) / 100% (80.0%) / 3.3% | yes |
| r2 | r1 without the "search, input, accessibility" clause | 100% (99.2%) / 100% (77.9%) / 9.5% | 100% (89.7%) / 100% (79.5%) / 4.2% (3 TypeSafe errors) | no, worse on tune |
| r3 | r1 plus the gate wording (below) | 100% (99.2%) / 100% (80.0%) / 4.0% | 100% (90.8%) / 100% (80.0%) / 2.5% | yes |

**Applied in r1** (`SEVERITY_QUESTION`, mirrored in the triage rubric):
- **low:** gains "a display-only glitch that corrects itself on a refresh (a stale count, badge, or list)".
- **medium:** gains "a search, input, or accessibility defect that costs time but leaves another route" and "a money amount, balance, or sign shown wrongly is at least medium, never cosmetic".
- **high:** gains "a wrong balance, amount, or statement shown in a core money view even when stored data is intact".

**Applied in r3** (the needs-info gate):
- **proceed:** gains "a question, chore, or feature request that names its subject or the action wanted … is proceed, since the symptom, location, and expected-behavior tests apply only to defect reports".
- **needsInfo:** gains "brevity, a casual tone, or a missing identifier is not a reason when a concrete symptom and location are named".
- **Effect:** needs-info answers on tune fell from 70 runs across 13 cases to 11 runs across 2. Before, Jev asked for more detail on plain questions, chores, and a named 404. The one genuinely thin report (`needs-info-transfer-feels-wrong`) still gets needs-info at 0.96–0.97.

**Honest notes:**
- **r1 holdout dip:** at 6 runs, r1 lowered holdout strict severity from 82.5% to 80.0%. `h-payees-index-check` moved from low to its accepted medium. Lenient severity stayed at 100%, and fallback improved.
- **r2 was prompted by that dip** and was rejected.
- **Not applied (case-specific or conflicting, as the judge itself noted):**
  - a Bug/Story carve-out for dialogs closed by a click outside (it conflicts with TLSSN-43's direction)
  - a severity default for vague reports
  - a "crash on some records is high" rule
- **Final critique** (5 cases left): the judge proposed three more general edits (a wrong label or date in a money view stays medium; "do we do X?" is a Task; a regression report needs no repro steps). They were not applied, because the loop was capped at three rounds.

## The type guard

`typeContradicted` holds back a confident Story or Task over words that say something that exists is broken now. Examples: "doesn't show … I typed", "stopped working", "used to", a 500, a blank page.
- **Review fix:** an error, 404, or 500 that the reporter asks for no longer counts, and neither does a request after "since the release".
- **Coverage:** the guard matches 15 dataset texts, all Bugs, and no Story or Task case.
- **Live effect:** it never fired in these runs, because Jev's type was already right. It is a backstop against a regression, not the source of the gain.
