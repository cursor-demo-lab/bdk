---
description: Definitions and tie-breakers for classifying an issue as bug, question, or feedback, plus the severity ladder.
---

<!-- The host Jev judge's criteria in agent/lib/jev-triage.ts mirror this file. Change them together. -->

# Triage rubric

## Kinds

- **bug**: existing behaviour is broken, erroring, slow, missing, or
  wrong now against what the reporter expects, and they want it
  diagnosed or fixed. It usually has a symptom, an error, an id, a
  timestamp, or steps. Soft wording is still a bug: "doesn't show",
  "stopped working", "used to", "is wrong", "I typed X but".
- **question**: the reporter wants to know something that has an answer
  (how does X work, is Y expected, who owns Z). Someone has to look it
  up, not fix it.
- **feedback**: an opinion, a suggestion, a feature idea, or a change
  to behaviour that works as built (a new field, option, warning, or
  confirmation step). The reporter is telling the team something, not
  asking it to find anything out. Jira files it as a Story.

## Tie-breakers

- "This is annoying, you should change X" is feedback even when it
  sounds like a complaint.
- A question about a specific failure that already happened is a bug.
  "Why did my export fail yesterday?" needs an investigation, not a
  lookup.
- An issue that reports a bug and suggests a fix is a bug.
- A known bug with a workaround that only works sometimes is a bug. The
  unreliable workaround is the thing to explain.
- A feature idea phrased as a question ("could we have dark mode?") is
  feedback.
- A bug report that ends with a polite ask for the fix is a bug. "The
  confirmation doesn't show the reference note I typed. Could it show
  the note?" is a bug: the user's own input is dropped (TLSSN-43).
- "Doesn't show" about something the product never showed is feedback:
  "The Payees list doesn't show the BSB, could it?" asks for new
  information. About the user's own input, a setting they chose, or a
  value that should be there, it is a bug.
- An action that does what it says (log out, a session timeout,
  closing a dialog) that the reporter wants to ask first or keep a
  draft is feedback, even when typed input was lost.

## Severity

- **urgent**: data loss (stored data deleted or corrupted, money sent
  twice or to the wrong account), security exposure (a leak,
  unauthorised access), or an outage (the service down, people cannot
  log in, many users blocked with no workaround).
- **high**: a core flow is broken or wrong for some users, no
  reasonable workaround, including a wrong balance, amount, or
  statement shown in a core money view even when stored data is
  intact. Not a request to change intended behavior.
- **medium**: broken or wrong with a workaround, a sharp edge that
  costs time, or a request to change how something behaves (a
  confirmation step, a warning, a default). A search, input, or
  accessibility defect that costs time but leaves another route is
  medium. A money amount, balance, or sign shown wrongly is at least
  medium, never cosmetic.
- **low**: cosmetic, minor friction, a display-only glitch that
  corrects itself on a refresh (a stale count, badge, or list),
  questions, copy or UX suggestions, and most feedback.

Questions and feedback default to low unless the issue shows real
user impact. A UX, copy, confirmation-step, or behavior-change request
is low or medium, never high or urgent, unless the reporter's words
name data loss, a security exposure, or an outage. Losing what was
typed in a form is not data loss. When those words are missing, host
code caps a question at low, feedback (a Story or Task) at medium, and
a bug at medium only when the words show typed input, how a UI element
looks, or a change the reporter wants; any other bug keeps the pick.
