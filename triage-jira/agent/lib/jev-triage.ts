import type { HostMcpRegistry } from "@cursor/july";
import { decide, type ChoiceAnswer } from "@cursor/july/extensions/jev";
import { factoryModel, LIGHT_MODEL, type FactoryModel } from "./factory-model.js";
import { projectIssueTypes, type IssueTypeRef, type IssueTypeWrite } from "./issue-type.js";
import type { TriageKind, TriageSeverity, TriageVerdict } from "./triage-verdict.js";
import type { KeyedKv } from "./kv-keys.js";

// Host-side Jev judge. Jev answers three Choices over the reporter's words:
// the Jira issue type (the project's real type names), severity, and a
// needs-info gate. It is asked once, before any model turn (`askTriageJev`):
// triage-jira's jev-first.ts on the issue-created wake, factory-desk's
// intake-triage.ts on a Slack filing request. When all three clear the bar,
// triage is Jev's alone (`templateVerdict`) and no model turn runs. Else the
// fallback turn's verdict is judged with those same answers (no second
// TypeSafe call): a confident type goes on the ticket and sets the kind the
// planner gates on; any failure keeps the model's verdict (fail-open), so a
// TypeSafe or Jira outage never stops triage. Shared verbatim by triage-jira
// and factory-desk (scripts/copies-parity.test.mjs).

/** A Jev choice is acted on only strictly above this probability. */
export const JEV_THRESHOLD = 0.52;

export function aboveBar(probability: number): boolean {
  return probability > JEV_THRESHOLD;
}
export const JEV_TIMEOUT_MS = 8_000;
const DESCRIPTION_MAX = 4_000;

// One criterion per Jira issue type triage may set. Only the ones the
// project lists are asked. Wording mirrors triage-jira's
// agent/skills/triage-rubric.md (factory-desk inlines it in
// agent/lib/triage-rubric.ts); change them together. A project type without a criterion here is never
// chosen: add its criterion to let triage set it.
//
// The line between Bug and Story is what exists today, not how the ask is
// phrased. TLSSN-43 ("the confirmation doesn't show the reference note I
// typed … could it show the note?") went in as a Story because it ends in a
// polite request; the contrastive examples below are the cases
// factory-desk/evals/jev-triage/cases.ts measures. Run
// `npm run eval:jev-triage` in factory-desk after changing any of this.
export const ISSUE_TYPE_CRITERIA: Readonly<Record<string, string>> = {
  Bug: "existing behaviour that is broken, missing, or wrong versus what the user expects: an error, a crash, a slow page, a wrong value, a search, filter, or check that misses or rejects what users reasonably enter, or something the user typed, chose, or saved that the product drops, hides, or ignores; a regression (used to work, stopped working, anymore). Still a Bug when put softly (doesn't show, is wrong, I typed X but) or when it ends with a suggested fix (could it show X?); includes a question about a specific failure that already happened",
  Story: "a new capability the product never had, or a change to behaviour that works as built: a feature idea, an addition, a new option, warning, or confirmation step, or a suggestion (could we add, there's no way to, would be nice if). An action that does what it says (log out, a timeout, closing a dialog) and the reporter wants it to ask first or keep a draft is a Story, even if typed input was lost. Not a Story when something that exists today is broken or wrong, even if the fix is asked for as a request",
  Task: "neither a defect nor a product change: a question to answer or look up, a dependency upgrade, a clean-up, docs, a rename, a configuration or operational chore",
};

// With no Story type to choose (factory-desk's Bug-and-Task default), a
// feature request is filed as a Task, so the Task criterion takes it.
const TASK_WITHOUT_STORY = "work that is not a defect: a new capability or a change to behaviour that works as built, a question to answer or look up, a dependency upgrade, a clean-up, docs, a rename, a configuration or operational chore";

const TYPE_INSTRUCTIONS =
  "Which Jira issue type fits this ticket? Decide by what exists today, not by how the ask is phrased: if the reporter describes existing behaviour that is broken, missing, or wrong versus what they expect, it is a Bug even when they politely ask for the fix. When the product does what it was built to do and the reporter wants something new or different (an extra field, a confirmation step, a draft kept), it is a Story.";

/** Used when the project's list cannot be read. Bug and Task are the types factory-desk files on TLSSN; Story is the team-managed software default. */
export const DEFAULT_ISSUE_TYPES: readonly IssueTypeRef[] = [{ name: "Bug" }, { name: "Story" }, { name: "Task" }];

const SEVERITY_QUESTION = {
  type: "choice",
  instructions:
    "How severe is the reported impact? Questions, feature requests, and asks for a UX, copy, or confirmation-step change are low or medium: they are never high or urgent unless the reporter's words name data loss, a security exposure, or an outage.",
  criteria: {
    low: "cosmetic, minor friction, a display-only glitch that corrects itself on a refresh (a stale count, badge, or list), questions, copy or UX suggestions, and most feedback",
    medium: "broken or wrong with a workaround, a sharp edge that costs time, or a request to change how something behaves (a confirmation step, a warning, a default); a search, input, or accessibility defect that costs time but leaves another route; a money amount, balance, or sign shown wrongly is at least medium, never cosmetic",
    high: "a core flow is broken or wrong for some users with no reasonable workaround, including a wrong balance, amount, or statement shown in a core money view even when stored data is intact; not a request to change intended behavior",
    urgent: "data loss (stored data deleted or corrupted, money sent twice or to the wrong account), a security exposure (a leak, unauthorised access), or an outage (the service down, people cannot log in, everyone blocked); losing what was typed in a form is not data loss",
  },
} as const;

const SEVERITY_RANK: Readonly<Record<TriageSeverity, number>> = { low: 0, medium: 1, high: 2, urgent: 3 };

// calibrateSeverity is a safety net over Jev's severity. It can only lower it,
// and it caps only on clear evidence; anything else keeps Jev's severity.
// Its failures are graded: capping a genuine report of the user's stored data
// being lost is High; leaving a common cosmetic, typed-input, or
// feature-request report at Jev's urgent is Medium; an unrecognised phrasing
// left at Jev's severity is Low. Hence the order below:
// - A loss or critical phrase (LOSS_LANGUAGE, CRITICAL_LANGUAGE) in the
//   reporter's words means no cap, whatever else the text says. Every
//   exclusion reads only its own match: a negation right before the phrase,
//   a negated loss verb, or a transient word inside the lost object's own
//   noun phrase (the `object` group each loss pattern names). Words elsewhere
//   in the sentence never hide a loss: "I saved a draft and my payees were
//   deleted" is a report of loss, and "Traffic is down from 10k to 2k" reads
//   as an outage and is left to Jev.
// - Without one, a Story, Task, feedback, or question is at most medium, a
//   question at most low: Jev's own type is the evidence.
// - A Bug is capped to medium only when the text positively reads as typed
//   input (a transient lost object, or a typed-input phrase), a UI element's
//   appearance, or a UX or feature request (EVIDENCE). "Payees deleted after
//   the update" names nothing the guard knows, so it keeps Jev's severity.
const UI_ELEMENT = String.raw`(?:icons?|buttons?|tooltips?|avatars?|filters?|toolbars?|menus?|sidebars?|banners?|badges?|layouts?|themes?|colou?rs?|fonts?|tabs?|columns?|notifications?|animations?|images?|logos?|headers?)`;
const DISPLAY_PLACE = String.raw`\s+in\s+(?:dark|light)\s+mode\b`;
// A determiner opens the lost object's noun phrase.
const DETERMINER = String.raw`(?:my|our|all|every|saved|stored|existing|the|a|an|this|that|some)`;
// A conjunction or subordinator ends a noun phrase and opens another clause,
// so it is never read as a modifier of the lost object: "a draft and my
// payees" is two phrases, "my payees while typing" two clauses.
const CLAUSE_WORD = String.raw`(?:and|but|or|nor|so|yet|then|while|whilst|when|whenever|as|after|before|because|since|if|until|till|once|unless|where|whereas|although|though|which|who)`;
// A modifier inside the noun phrase: a word, not a clause word, and not a
// bare dash joining two phrases ("a draft - payments were deleted").
const MODIFIER = String.raw`(?!${CLAUSE_WORD}\b)\w[\w'-]*`;
const AUXILIARY = String.raw`(?:is|are|was|were|got|get|gets|has|have|had)\s+(?:(?:been|all|just|now|suddenly|completely|somehow)\s+){0,2}`;

// A loss phrase means no cap at all. Typed-but-unsaved form input is not
// data loss, so "lose" alone does not count: it needs a stored-data noun.
// A loss phrase is dropped when its clause negates it ("no data was lost")
// or makes it hypothetical ("someone could lose data"), or when its `object`
// is what the user was typing (transientObject).
const LOSS_LANGUAGE: readonly RegExp[] = [
  /\bdata[- ]loss\b/gi,
  /\b(?:lost|lose|loses|losing|deleted|deletes|deleting|removed|removes|wiped|wipes|erased|erases|purged|purges|corrupt(?:ed|s|ion|ing)?|overwritten|overwrote|overwrites|disappeared|vanished)\b(?<object>.{0,40}?\b(?:data|database|records?|rows?|files?|accounts?|transactions?|payments?|orders?|history|backups?|money|funds|balances?)\b)/gi,
  // A noun-first phrase ("payments were deleted") carries the determiner and
  // modifiers before its noun, so "my draft payments were deleted" reads as
  // typed input, while "I saved a draft and payments were deleted" opens on
  // "payments": a clause word is never a modifier.
  new RegExp(String.raw`\b(?<object>(?:${DETERMINER}\s+(?:${MODIFIER}\s+){0,2})?(?:data|database|records?|rows?|files?|accounts?|transactions?|payments?|orders?|history|backups?|money|funds|balances?|deposits?|savings))\b.{0,40}?\b(?:lost|deleted|removed|wiped|erased|purged|corrupt(?:ed)?|overwritten|missing|disappear(?:s|ed|ing)?|vanish(?:es|ed|ing)?|gone)\b`, "gi"),
  // The user's own saved data, whatever it is called: "my payees were
  // deleted", "I lost all my payees". A transitive verb needs its auxiliary,
  // so "our testers lost a half-filled transfer" is not a report of loss.
  new RegExp(String.raw`\b(?<object>(?:my|our|all|every|saved|stored|existing)\s+(?:[\w'-]+\s+){0,3}?)${AUXILIARY}(?:deleted|lost|wiped|erased|purged|destroyed)\b`, "gi"),
  // A display verb ("all my contacts disappeared") is loss only when what went
  // is not a UI element and not a display mode: "all my icons disappeared from
  // the toolbar" and "all my charts vanished in dark mode" are cosmetic, while
  // "all my payees disappeared from the page" is loss.
  new RegExp(String.raw`\b(?<object>(?:my|our|all|every|saved|stored|existing)\s+(?:(?!${UI_ELEMENT}\b)[\w'-]+\s+){0,3}?)(?:${AUXILIARY}(?:gone|missing|removed|disappeared|vanished)|disappeared|vanished|went missing)\b(?!${DISPLAY_PLACE})`, "gi"),
  // The object after the determiner is part of the match, so "lost my
  // half-filled transfer" reads as typed input; a clause word ends it, so a
  // later "while I was typing" does not.
  new RegExp(String.raw`\b(?:lost|lose|deleted|deletes|wiped|wipes|erased|erases|removed|removes|purged)\s+(?<object>(?:all\s+(?:of\s+)?|every\s+)?(?:my|our|every|all|saved|stored|existing)\b(?:\s+${MODIFIER}){0,3})`, "gi"),
  /\b(?:I|we)\s+(?:had\s+|have\s+|'d\s+)?(?:saved|stored|added|created|uploaded)\b(?<object>.{0,30}?)\b(?:deleted|lost|gone|wiped|erased|missing|removed|purged|disappeared|vanished)\b/gi,
];
// Losing what the user was typing (a form, a draft) is not stored data. The
// veto reads the match's `object` from its determiner (after a quantity, "all
// of my"): a transient word is the head ("lost my draft") or an adjective on
// it after at most one more modifier ("my draft transfer", "our new unsaved
// payees"). A transient word after the head is another clause ("lost my
// payees filling out the form"), one before the determiner is another phrase
// ("a draft and my payees"), and the noun "type" is not typing.
const TRANSIENT_OBJECT = new RegExp(String.raw`^(?:(?:all|both|some|most|many|half|\d+)\s+)?(?:of\s+)?${DETERMINER}\s+(?:(?:typing|filling (?:in|out))\b|(?:${MODIFIER}\s+)?(?:typed|half-filled|half filled|unsaved|drafts?)\b)`, "i");
function transientObject(match: RegExpMatchArray): boolean {
  const object = match.groups?.["object"];
  return object !== undefined && TRANSIENT_OBJECT.test(object.trim());
}
// Negated or hypothetical only when the word is right before the phrase
// ("no data", "didn't lose", "could lose") or negates its loss verb ("data
// was not lost"); "deleted and could not be recovered" still counts.
// A modal only before a base-form verb: "might have lost" is a real report.
const LOSS_NEGATED_BEFORE = /(?:\b(?:no|not|never|nothing|none|nobody|no one|without)|n't)\s+(?:\S+\s+)?$|\b(?:could|might|may|would)\s+(?:(?:easily|potentially|also|still)\s+)?$/i;
const LOSS_NEGATED_VERB = /(?:\b(?:not|never)|n't)\s+(?:(?:been|be|get|got|any)\s+)?(?:lost|lose|deleted|delete|removed|remove|wiped|erased|purged|corrupt\w*|overwritten|missing|gone|disappear\w*|vanish\w*)\b/i;

const CRITICAL_LANGUAGE: readonly RegExp[] = [
  /\b(?:balances?|statements?|totals?)\b.{0,20}\b(?:is|are|was|were|shows?|showing)\s+(?:wrong|incorrect|off)\b/gi,
  /\b(?:wrong|incorrect)\s+(?:balances?|amounts?|totals?)\b/gi,
  /\b(?:transferred|sent|paid|moved)\s+(?:\S+\s+){0,3}to\s+(?:the\s+)?wrong\b/gi,
  /\b(?:charged|sent|paid|debited|transferred|withdrawn|billed)\s+(?:me\s+|us\s+)?(?:twice|two times|double)\b/gi,
  /\bdouble[- ]?(?:charged?|charging|payments?|paid|billed|debit(?:ed)?)\b/gi,
  // A payment that went through twice is money sent twice, whatever else the text says about the form it was typed in.
  /\b(?:went through|submitted|processed|posted|applied|executed|taken|deducted)\s+(?:twice|two times|double)\b/gi,
  /\bduplicated?\s+(?:payments?|transfers?|transactions?|charges?|debits?|orders?)\b/gi,
  /\bwrong\s+(?:account|recipient|payee|person|customer)\b/gi,
  /\b(?:breach(?:ed|es)?|unauthori[sz]ed|vulnerab\w*|exploit(?:s|ed|able)?|xss|csrf|sql injection)\b/gi,
  // "leak" and "expose" alone are a memory leak or a UI setting.
  /\b(?:leak(?:s|ed|ing)?|expose|exposed|exposes|exposing|exposure)\b.{0,40}\b(?:data|tokens?|keys?|passwords?|secrets?|credentials?|pii|personal|emails?|accounts?|details|records?|statements?|documents?|pdfs?|files?)\b/gi,
  /\b(?:data|tokens?|keys?|passwords?|secrets?|credentials?|pii|emails?|statements?|documents?|pdfs?|files?)\b.{0,40}\b(?:leak(?:s|ed|ing)?|exposed|exposure)\b/gi,
  /\bsecurity\s+(?:hole|issue|bug|flaw|problem|incident)\b/gi,
  /\b(?:someone else's|another (?:user|customer)'s|other (?:users|customers)')\s+(?:data|account|details|information|info|records?|statements?|transactions?)\b/gi,
  /\boutage\b/gi,
  // Something is down. A drop in a measure ("down from 10k to 2k", "down by
  // 5%", "down to one column") reads the same way and is left to Jev's
  // severity: telling the two apart by regex capped real outages ("down from
  // 9 to 11", "down from the deploy") in earlier rounds, and leaving Jev is
  // the acceptable failure.
  /\b(?:site|website|app|service|server|api|prod|production|everything|system|platform|login|checkout|payments?)\s+down\b/gi,
  /\b(?:is|are|was|were|went|goes|going|has been|have been|been)\s+down\b/gi,
  /\b(?:can't|cannot|can not|unable to|couldn't)\s+(?:log ?in(?:to)?|sign ?in(?:to)?|login|access (?:(?:my|our|their|the|his|her) )?(?:accounts?|app|site|website|service|system|platform|portal|online banking))\b/gi,
  /\blocked out\b/gi,
  /\b(?:everyone|everybody|all users|all customers|every user|every customer|nobody|no one|no-one)\b.{0,40}\b(?:blocked|can't|cannot|unable|locked|errors?|5\d\d|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?)\b/gi,
  /\b(?:nobody|no one|no-one)\s+(?:can|is able to)\s+(?:log ?in|sign ?in|login|access|pay|check ?out|use|load|open)\b/gi,
  /\b(?:errors?|5\d\d|fail(?:s|ed|ing|ures?)?|crash(?:es|ed|ing)?|down)\b.{0,40}\b(?:for|to|on)\s+(?:everyone|everybody|all users|all customers|every user|every customer)\b/gi,
];
// Only a negation right before the phrase ("not a security issue"): a
// "don't know why" earlier in the clause must not hide a real outage.
const CRITICAL_NEGATED = /\b(?:not|no|never|isn't|wasn't|aren't)\s+(?:(?:a|an|the|any|really|actually)\s+){0,2}$/i;

// Clear evidence that a Bug is about what the reporter was typing, how a UI
// element looks, or a change they want. Read only when no loss or critical
// phrase was found, so a loss in words the guard does not know is still left
// at Jev's severity. The one residual risk is a report that says both in
// words the guard does not know ("Payees deleted after the update; could we
// add a restore option?"), which is why each pattern wants the whole phrase
// and not a word, and never a phrase that also states what the reporter
// expected or once entered: "typed in" alone is any data entry ("the payee I
// typed in yesterday is gone"), "should be" and "could it be" state an
// expected state ("the balance should be 500"), "in dark mode" alone or a
// layout noun alone says nothing about what went wrong.
const COSMETIC = String.raw`(?:gone|missing|disappeared|vanished|removed|hidden|invisible|misaligned|overlap(?:s|ped|ping)?|blurry|blurred|pixelated|cut off|truncated|clipped|squashed|stretched|shifted|jumps?|jumping|flickers?|flickering|off-?cent(?:re|er)(?:ed)?|too (?:small|big|large|wide|narrow|dark|light|low|high|close|far)|unreadable|illegible|garbled)`;
// The UI elements whose appearance is evidence: UI_ELEMENT less headers,
// columns, and images, which are also API headers, statement columns, and content.
const UI_WIDGET = String.raw`(?:icons?|buttons?|tooltips?|avatars?|filters?|toolbars?|menus?|sidebars?|banners?|badges?|layouts?|themes?|colou?rs?|fonts?|tabs?|notifications?|animations?|logos?)`;
const UI_PART = String.raw`(?:text|labels?|items?|set|rows?|area|spacing|padding)`;
// Verbs that only ask for a behaviour, never describe an expected state.
const REQUEST_VERB = String.raw`(?:ask|confirm|warn|say|offer|remember|default|allow|let|prompt|hide|read|rename|call|label)`;
// "should not be deleted" is a complaint about a loss, not a request.
const NOT_A_LOSS_COMPLAINT = String.raw`(?!(?:be\s+|get\s+|have\s+been\s+)?(?:delet\w*|remov\w*|wip\w*|eras\w*|los\w*|gone|missing|purg\w*|corrupt\w*|overwr\w*|disappear\w*|vanish\w*)\b)`;
const WRITER = String.raw`(?:I|we|they|he|she|you|users?|testers?|customers?)`;
const WHAT = String.raw`(?:what|everything|anything|something)\s+(?:that\s+)?${WRITER}`;
// Typing that was still going on when it went, told by its grammar and not by
// a list of times ("typed in yesterday", "a few days ago"): the progressive,
// typing into a form, typing cut short by an event, or the perfect closing its
// clause. "What I typed yesterday" or "everything I entered" is saved data.
// An input control, never a page or screen: "entered on the payees page" is a submission.
const INPUT_PLACE = String.raw`(?:in|into)\s+(?:the|a|an|my|our|this|that)\s+(?:\w+\s+){0,2}(?:form|box|fields?|dialog|modal|editor|textarea|input)\b`;
// An event with its own subject that ends the typing: "before the page refreshed", "when it timed out".
const CUT_SHORT = String.raw`(?:\s+(?:was|were|got|is|are)\s+(?:lost|gone|wiped|cleared|erased|deleted|dropped))?\s+(?:before|when|as|until|while|because)\s+(?:(?:the|my|our|this)\s+(?:page|app|site|form|browser|tab|session|screen|window|modal|dialog)|it)\s+(?:refreshed|reloaded|re-loaded|crashed|froze|logged\s+(?:me|us)\s+out|timed\s+out|closed|died|went\s+(?:blank|down|away|back)|reset|navigated|redirected|expired|restarted|kicked\s+(?:me|us)\s+out)\b`;
const EVIDENCE: readonly RegExp[] = [
  // What was being typed when it went: "what I was typing", "what I typed in the transfer form", "everything I
  // typed before the page refreshed", "I lost everything I had typed", "the details I was typing", "I was typing
  // a new payee". Only the progressive for a concrete object, since "the payee I typed in yesterday" is saved
  // data, and "entered" only when an event cut it short, since "everything I entered" is a submission.
  new RegExp(String.raw`\b${WHAT}\s+(?:was|were|am|are|'d been|had been)\s+(?:typing|filling in|entering|writing)\b`, "i"),
  new RegExp(String.raw`\b${WHAT}\s+(?:had\s+|'d\s+)?(?:typed|filled in|keyed in)\s+${INPUT_PLACE}`, "i"),
  new RegExp(String.raw`\b${WHAT}\s+(?:had\s+|'d\s+)?(?:typed|entered|filled in|keyed in|written)${CUT_SHORT}`, "i"),
  new RegExp(String.raw`\b${WHAT}\s+(?:had|'d)\s+typed(?=\s*(?:[.;!?,)]|$))`, "i"),
  new RegExp(String.raw`\b(?:details?|text|input|changes|fields?|message|comment|note|reply|answers?|values?|entries|transfer|payment|form|work)\b[^.;!?]{0,20}?\b${WRITER}\s+(?:was|were|'d been|had been)\s+(?:typing|filling(?: in| out)?|entering|writing)\b`, "i"),
  new RegExp(String.raw`\b${WRITER}\s+(?:was|were|am|are|'d been|had been)\s+(?:typing|filling in|filling out|entering)\s+(?:a|an|the|my|our|their|some|this)\s+(?:\w+\s+){0,2}(?:comment|note|message|reply|answer|transfer|payment|payee|form|text|details|values?|amounts?|description|title|fields?|address|password|username|search)\b`, "i"),
  // Unsaved or half-filled input: "half-filled transfer", "unsaved input", "the form has something typed in", "re-entering every transfer".
  /\b(?:half-filled|half filled|unsaved (?:input|changes?|form|work|drafts?|edits?|fields?|text|entries|transfers?|payments?|payees?)|form (?:has|had|with) (?:\w+ )?(?:typed in|input)|form input|re-?enter(?:ed|ing|s)?|retyp(?:e|ed|ing)|draft (?:transfers?|payments?|payees?|messages?|notes?|repl(?:y|ies)|comments?|forms?|text|changes))\b/i,
  // A UI element's appearance, with the element as the subject: "the logo
  // disappeared from the header", "icons are missing", "the tooltip overlaps
  // the logo", "button label is cut off", "the charts vanished in dark mode".
  // Where something vanished from is not evidence: "customer payees vanished
  // from the payees tab" is a loss.
  new RegExp(String.raw`\b${UI_WIDGET}\b(?:\s+${UI_PART})?(?:\s+(?:in|on|at|of|under|from)\s+(?:the\s+|my\s+|our\s+)?\w+)?(?:\s+(?:is|are|was|were|has|have|had|got|get|went|looks?|seems?|appears?|renders?|now))*\s+(?:(?:been|now|just|all|still|also|completely|slightly|a bit)\s+)*${COSMETIC}\b`, "i"),
  new RegExp(String.raw`\b(?:misaligned|blurry|blurred|overlapping|truncated|clipped|hidden|invisible|missing|squashed|stretched|garbled|unreadable|pixelated)\s+(?:\w+\s+)?${UI_WIDGET}\b`, "i"),
  new RegExp(String.raw`\b(?:${UI_WIDGET}|labels?|wording|copy)\s+(?:is|are|looks?|seems?|feels?)\s+(?:a bit\s+|slightly\s+|way\s+|all\s+)?(?:wrong|off|odd|weird|inconsistent)\b`, "i"),
  /\b(?:gone|missing|disappeared|vanished|invisible|hidden|unreadable|illegible|too dark|too light|wrong colou?r)\s+in (?:dark|light) mode\b/i,
  /\b(?:misaligned|typos?|misspel(?:t|led|ling)s?|off-?cent(?:re|er)|cosmetic|pixelated|overlapping text|copy (?:change|tweak|fix))\b/i,
  // A change the reporter wants: "could it ask to confirm", "would be nice", "please add", "should say", "add a warning".
  new RegExp(String.raw`\b(?:could|can|would)\s+(?:it|we|you|this|that|the\s+\w+(?:\s+\w+)?)\s+(?:please\s+)?${NOT_A_LOSS_COMPLAINT}${REQUEST_VERB}\b`, "i"),
  /\b(?:would|it would|it'd|that would|this would)\s+(?:be\s+)?(?:nice|nicer|great|good|helpful|better|useful|ideal|cleaner|clearer)\b/i,
  /\b(?:please|pls|kindly)\s+(?:add|make|let|consider|allow|ask|change|rename|hide|expose|reword|default|don't|do not)\b/i,
  new RegExp(String.raw`\b(?:should|ought to)\s+(?:not\s+|never\s+|also\s+|probably\s+)?${NOT_A_LOSS_COMPLAINT}${REQUEST_VERB}\b`, "i"),
  /\b(?:suggestions?|feature request|nice[- ]to[- ]have|enhancement|improvement idea|quality of life)\b/i,
  /\b(?:add|show|have|include|offer)\s+(?:a|an|some)\s+(?:\w+\s+)?(?:confirm(?:ation)?|warning|option|setting|toggle|prompt|dialog|checkbox|shortcut|filter|button|link|tooltip|autosave|undo|way to)\b/i,
  /\b(?:ask (?:to|for|before) confirm|confirm(?:ation)? (?:step|dialog|prompt|before)|a warning before|an undo)\b/i,
];

/** The tail of the clause a match sits in, for a negation right before the phrase. */
function clauseBefore(text: string, match: RegExpMatchArray): string {
  // Only the last 30 characters are kept, so a bounded window reads the same and keeps many matches linear.
  return (text.slice(Math.max(0, (match.index ?? 0) - 64), match.index).split(/[.;!?,]|\bbut\b/i).at(-1) ?? "").slice(-30);
}

// True when some match of some pattern is not excluded.
function mentioned(patterns: readonly RegExp[], text: string, excluded: (clause: string, match: RegExpMatchArray) => boolean): boolean {
  return patterns.some((pattern) => Array.from(text.matchAll(pattern)).some((match) => !excluded(clauseBefore(text, match), match)));
}

// `reported`: a loss phrase that is not negated, hypothetical, or transient.
// `transient`: a loss phrase whose object is what the user was typing, which
// is evidence of a typed-input report when nothing else was lost.
function lossRead(text: string): { reported: boolean; transient: boolean } {
  let transient = false;
  const reported = LOSS_LANGUAGE.some((pattern) =>
    Array.from(text.matchAll(pattern)).some((match) => {
      if (LOSS_NEGATED_BEFORE.test(`${clauseBefore(text, match)} `) || LOSS_NEGATED_VERB.test(match[0])) return false;
      if (transientObject(match)) {
        transient = true;
        return false;
      }
      return true;
    })
  );
  return { reported, transient };
}

/** Case, line breaks, curly apostrophes, and full-width forms never change what the guard reads. */
function guardText(text: string): string {
  return text.normalize("NFKC").replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'").replace(/\s+/g, " ");
}

// The word lists are English. A report with any real run of another script
// (a Japanese sentence inside English) is left to Jev's or the model's
// severity rather than capped on words the guard cannot read.
function readableAsEnglish(text: string): boolean {
  return /\p{Script=Latin}/u.test(text) && !/(?:(?!\p{Script=Latin})\p{L}){4,}/u.test(text);
}

/**
 * Host-side severity guard over a verdict from Jev or the model. It never
 * raises, and it caps only on clear evidence. With no data-loss, security,
 * outage, or money-loss words in the reporter's text: a Story, Task, or
 * feedback is at most medium and a question at most low; a Bug is at most
 * medium only when the text reads as typed input, a UI element's appearance,
 * or a UX or feature request, and otherwise keeps its severity. `type` is a
 * Jira type name or a triage kind.
 */
export function calibrateSeverity(input: { text: string; type: string; severity: TriageSeverity }): TriageSeverity {
  const ceiling = severityCeiling(input);
  return SEVERITY_RANK[input.severity] > SEVERITY_RANK[ceiling] ? ceiling : input.severity;
}

/** The highest severity `calibrateSeverity` leaves standing for this text and type; `urgent` means it leaves the severity alone. */
export function severityCeiling(input: { text: string; type: string }): TriageSeverity {
  const read = guardText(input.text);
  if (!readableAsEnglish(read)) return "urgent";
  const loss = lossRead(read);
  if (loss.reported || mentioned(CRITICAL_LANGUAGE, read, (clause) => CRITICAL_NEGATED.test(clause))) return "urgent";
  const kind = input.type.trim().toLowerCase();
  if (kind === "question") return "low";
  // A Story or Task can describe a sharp edge that costs time, which the rubric calls medium.
  if (kind === "story" || kind === "task" || kind === "feedback") return "medium";
  return loss.transient || EVIDENCE.some((pattern) => pattern.test(read)) ? "medium" : "urgent";
}

/** A judgment whose severity went through `calibrateSeverity`, so settling it never puts back what the guard capped. */
export function calibrateJudgment(judgment: TriageJudgment, text: string): TriageJudgment {
  if (judgment.status !== "judged" || !judgment.severity.applied) return judgment;
  // A type the guard held back is not evidence for a cap; the ticket keeps the model's kind, so that is what is read.
  const type = judgment.type.held === true ? judgment.type.model : judgment.type.choice;
  const choice = calibrateSeverity({ text, type, severity: judgment.severity.choice });
  if (choice === judgment.severity.choice) return judgment;
  return { ...judgment, severity: { ...judgment.severity, choice, applied: judgment.severity.applied && choice !== judgment.severity.model, cappedFrom: judgment.severity.choice } };
}

// Words that say something that exists is broken now: a regression, an
// error, a crash, or the reporter's own input dropped. Only these, not a
// bare "doesn't" or "can't": "there's no way to export" and "doesn't let
// you attach a receipt" are Stories. "Anymore" counts only after a negation
// ("doesn't load anymore", not "is there any more documentation?"), and
// "broken down" / "broke out" are not breakage.
const DEFECT_LANGUAGE: readonly RegExp[] = [
  /\b(?:used to|no longer|stopped (?:working|showing|loading|saving|sending|opening)|stops working|regress(?:ed|ion)|broke(?:n)?(?!\s+(?:down|out|up|into|even|apart)\b)|(?:does ?n[o']t|is ?n[o']t|not) working)\b/i,
  /(?:n't|\b(?:not|never|cannot|nothing|nobody|no one))(?:\s+[\w'-]+){0,10}?\s+any ?more\b/i,
  /\b(?:since|after) (?:this morning|yesterday|last (?:week|night)|(?:the |today's |yesterday's |last week's |this week's )?(?:release|deploy(?:ment)?|update|upgrade))\b(?!,? (?:(?:could|can|would|will) (?:we|you|someone)|please|let's|we (?:should|could)|(?:also )?add|also)\b)/i,
  /\b(?:errors?|exceptions?|crash(?:es|ed|ing)?|white screen|blank (?:page|screen|pdf)|stack ?trace|(?:http )?(?:404|500|502|503))\b/i,
  /\bI (?:typed|entered|set|chose|picked|selected|saved|uploaded)\b.{0,80}?\bbut\b/i,
  /\b(?:does ?n[o']t|do ?n[o']t|wo ?n[o']t|is ?n[o']t|never) (?:show|display|keep|save|remember|include|appear)s?\b.{0,60}?\b(?:I|we|you|they) (?:typed|entered|set|chose|picked|selected|saved|added)\b/i,
];

// An error, 404, or 500 the reporter asks for ("add a 404 page", "show an
// error when…", "the error message could be friendlier") is a request, not a
// symptom, so it is removed before `DEFECT_LANGUAGE` reads the text.
const REQUESTED_ERROR: readonly RegExp[] = [
  /\b(?:add|show|display|return|build|create|design|want|need)(?: (?:an?|the|some|a new|custom|friendly|friendlier|clearer|better|proper|nicer|inline))* (?:errors?|404|500)(?: (?:messages?|pages?|states?|screens?|banners?|toasts?))?\b/gi,
  /\berror (?:messages?|text|copy)\b[^.?!]{0,60}?\b(?:could|should|would|might|can) be (?:friendlier|clearer|nicer|better|shorter|more|less)\b/gi,
];

/**
 * Host-side type guard over Jev's answer. A Story or Task answer over words
 * that say something that exists is broken now (`DEFECT_LANGUAGE`) is not
 * trusted: no Jev-only triage and no forced Jira type, so the fallback turn
 * types it with the rubric. It never picks a type itself, and a Bug answer
 * is never held back.
 */
export function typeContradicted(input: { text: string; type: string }): boolean {
  const type = input.type.trim().toLowerCase();
  if (type !== "story" && type !== "task") return false;
  const read = REQUESTED_ERROR.reduce((text, pattern) => text.replace(pattern, " "), guardText(input.text));
  return DEFECT_LANGUAGE.some((pattern) => pattern.test(read));
}

/** A judgment whose type `typeContradicted` holds back: not confident, so it is neither written to Jira nor followed by the kind. */
export function guardJudgmentType(judgment: TriageJudgment, text: string): TriageJudgment {
  if (judgment.status !== "judged" || !typeContradicted({ text, type: judgment.type.choice })) return judgment;
  return holdJudgmentType(judgment);
}

/** The judgment with a confident type held back, for a caller that already ran the guard over the reporter's words (factory-desk's intake). */
export function holdJudgmentType(judgment: TriageJudgment): TriageJudgment {
  if (judgment.status !== "judged" || !judgment.type.confident) return judgment;
  return { ...judgment, type: { ...judgment.type, confident: false, held: true } };
}

const GATE_QUESTION = {
  type: "choice",
  instructions: "Can the team act on this issue as written, or must the reporter supply one specific missing detail first?",
  criteria: {
    proceed: "the issue names what is wrong or wanted well enough to investigate or plan; a question, chore, or feature request that names its subject or the action wanted (how does X work, do we do Y, upgrade Z, add an X export) is proceed, since the symptom, location, and expected-behavior tests apply only to defect reports",
    needsInfo: "too thin to act on: no symptom, no location, or no expected behavior, so the reporter must be asked for a specific detail. Brevity, a casual tone, or a missing identifier (account, user, transaction id) is not a reason when a concrete symptom and location are named",
  },
} as const;

const SEVERITIES: readonly TriageSeverity[] = ["low", "medium", "high", "urgent"];
const GATES = ["proceed", "needsInfo"] as const;

/** The project types triage can choose among, with the project's exact names and ids. */
export function choosableTypes(types: readonly IssueTypeRef[]): IssueTypeRef[] {
  return types.flatMap((type) => {
    const known = Object.keys(ISSUE_TYPE_CRITERIA).find((name) => name.toLowerCase() === type.name.trim().toLowerCase());
    return known === undefined ? [] : [type];
  });
}

export function triageQuestions(types: readonly IssueTypeRef[]) {
  const criteria: Record<string, string> = {};
  const story = types.some((type) => type.name.trim().toLowerCase() === "story");
  for (const type of types) criteria[type.name] = type.name.trim().toLowerCase() === "task" && !story ? TASK_WITHOUT_STORY : criterionFor(type.name)!;
  return {
    issueType: { type: "choice", instructions: TYPE_INSTRUCTIONS, criteria },
    severity: SEVERITY_QUESTION,
    gate: GATE_QUESTION,
  } as const;
}

/**
 * The kind the planner gates on, from a Jira type Jev set. Bug and Story plan.
 * Task covers both a question and a small request, so it keeps the model's
 * question (the planner's skip) and otherwise plans as feedback.
 */
export function kindForType(typeName: string, modelKind: TriageKind): TriageKind {
  const name = typeName.trim().toLowerCase();
  if (name === "bug") return "bug";
  if (name === "story") return "feedback";
  return modelKind === "question" ? "question" : "feedback";
}

/** The inbound issue as the webhook delivered it, before the model saw it. */
export type InboundIssue = {
  identifier: string;
  title: string;
  description: string;
  reporter?: string;
  issueType?: string;
};

export type JudgeState = {
  source: "webhook" | "model";
  title: string;
  description: string;
  reporter?: string;
};

export type JudgedLabel<T extends string> = {
  choice: T;
  probability: number;
  model: T;
  applied: boolean;
  /** Jev's own choice when calibrateSeverity lowered it; `probability` is still that choice's. */
  cappedFrom?: T;
};

export type JudgedType = {
  choice: string;
  id?: string;
  probability: number;
  /** The model's kind, which the chosen type may replace. */
  model: TriageKind;
  confident: boolean;
  /** What happened on the ticket. `not_written` below the bar; `eval` in eval sessions. */
  jira: IssueTypeWrite["status"] | "not_written" | "eval";
  message?: string;
  /** True when the type is on the ticket (or would be, in an eval) and the kind follows it. */
  applied: boolean;
  /** Above the bar, but `typeContradicted` held it back: the report's words say something is broken now. */
  held?: true;
};

export type TriageJudgment =
  | { status: "skipped"; reason: "no_key" }
  | { status: "unavailable"; message: string }
  | {
      status: "judged";
      source: JudgeState["source"];
      types: "project" | "default";
      type: JudgedType;
      severity: JudgedLabel<TriageSeverity>;
      // Recorded, never applied: forcing Needs info needs a question for the
      // reporter, and Jev decides, it does not write one.
      gate: { choice: (typeof GATES)[number]; probability: number; model: (typeof GATES)[number] };
      /** Recorded by jev-first.ts with no model turn: the "model" fields are Jev's own template. */
      jevOnly?: true;
    };

export type JudgeInput = {
  verdict: TriageVerdict;
  inbound?: InboundIssue;
  types: { source: "project" | "default"; types: readonly IssueTypeRef[] };
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** What jev-first.ts already got from Jev on the wake; `unavailable` when that call failed. Either way no second call. */
  asked?: JevAnswers | "unavailable";
};

export type JevAnswers = { issueType: ChoiceAnswer; severity: ChoiceAnswer; gate: ChoiceAnswer };

/** Asks Jev. The result says what to write; `settleJudgment` applies it once the Jira write is known. */
export async function judgeTriage(input: JudgeInput): Promise<TriageJudgment> {
  const types = choosableTypes(input.types.types);
  const state = judgeState(input.verdict, input.inbound);
  if (input.asked === "unavailable") return { status: "unavailable", message: "Jev did not answer on the wake" };
  if (input.asked !== undefined) return readAnswers(input.verdict, state.source, input.types.source, types, input.asked);
  const apiKey = input.env.TYPESAFE_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") return { status: "skipped", reason: "no_key" };
  if (types.length < 2) return { status: "unavailable", message: "the project lists fewer than two issue types triage can choose" };
  try {
    const answers = await askJev({ state, types, apiKey, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    return readAnswers(input.verdict, state.source, input.types.source, types, answers);
  } catch (error) {
    return { status: "unavailable", message: errorText(error) };
  }
}

export type JevAsk =
  | {
      status: "answered";
      answers: JevAnswers;
      state: JudgeState;
      /** The types Jev chose among: the project's, or the caller's defaults when the list could not be read. */
      types: { source: "project" | "default"; types: IssueTypeRef[] };
    }
  | { status: "skipped"; reason: "no_key" | "no_text" | "types" }
  | { status: "unavailable"; message: string };

/**
 * The one Jev call for a request: the project's issue types (or `defaultTypes`
 * when they cannot be read), then Jev's three answers. Never throws.
 */
export async function askTriageJev(input: {
  inbound: InboundIssue;
  project: string;
  mcp: HostMcpRegistry;
  kv: KeyedKv;
  env: Record<string, string | undefined>;
  defaultTypes?: readonly IssueTypeRef[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<JevAsk> {
  const apiKey = input.env.TYPESAFE_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") return { status: "skipped", reason: "no_key" };
  const { inbound } = input;
  if (inbound.title.trim() === "" && inbound.description.trim() === "") return { status: "skipped", reason: "no_text" };
  let listed: IssueTypeRef[] | undefined;
  try {
    listed = await projectIssueTypes(input.mcp, input.kv, input.project);
  } catch {
    listed = undefined;
  }
  const source = listed === undefined ? ("default" as const) : ("project" as const);
  const types = choosableTypes(listed ?? input.defaultTypes ?? DEFAULT_ISSUE_TYPES);
  if (types.length < 2) return { status: "skipped", reason: "types" };
  const state = judgeState({ identifier: inbound.identifier, kind: "question", severity: "low", title: inbound.title, summary: inbound.description, nextStep: "" }, inbound);
  try {
    const answers = await askJev({ state, types, apiKey, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    return { status: "answered", answers, state, types: { source, types } };
  } catch (error) {
    return { status: "unavailable", message: errorText(error) };
  }
}

/** Jev's confidence in a triage: the lowest of its three answers' probabilities, as a whole percent. */
export function jevConfidence(probabilities: readonly number[]): number | undefined {
  // A chosen answer always has a probability above 0; 0 or a non-number means it was missing.
  if (probabilities.length === 0 || probabilities.some((p) => !Number.isFinite(p) || p <= 0)) return undefined;
  // toFixed first: 0.775 * 100 is 77.49999…, which would round down.
  return Math.round(Number((Math.min(...probabilities) * 100).toFixed(6)));
}

export function answersConfidence(answers: JevAnswers): number | undefined {
  return jevConfidence([answers.issueType, answers.severity, answers.gate].map(probabilityOf));
}

/** True when the type, severity, and gate are all strictly above the bar: triage is Jev's alone. */
export function allAboveBar(answers: JevAnswers): boolean {
  return [answers.issueType, answers.severity, answers.gate].every((answer) => aboveBar(probabilityOf(answer)));
}

const TITLE_MAX = 80;

/**
 * Jev chooses, it does not write, so a Jev-only verdict's title, summary,
 * and next step are short templates over the reporter's title. A Task is a
 * question to the planner (it skips it), matching kindForType. Undefined
 * when Jev answered outside the labels.
 */
export function templateVerdict(issue: { identifier: string; title: string; description?: string; reporter?: string }, answers: JevAnswers): TriageVerdict | undefined {
  const choice = answers.severity.choice as TriageSeverity;
  if (!SEVERITIES.includes(choice)) return undefined;
  if (answers.gate.choice !== "proceed" && answers.gate.choice !== "needsInfo") return undefined;
  const typeName = answers.issueType.choice;
  const severity = calibrateSeverity({ text: issueText(issue), type: typeName, severity: choice });
  const kind = kindForType(typeName, "question");
  const needsInfo = answers.gate.choice === "needsInfo";
  const title = oneLine(issue.title) || issue.identifier;
  return {
    identifier: issue.identifier,
    kind,
    severity,
    title: cut(title, TITLE_MAX),
    summary: `${typeName} reported as "${cut(title, 160)}", ${severity} severity.`,
    nextStep: needsInfo ? NEEDS_INFO_ASK : TEMPLATE_NEXT_STEP[kind],
    ...(issue.reporter === undefined || issue.reporter === "" ? {} : { reporter: issue.reporter }),
    ...(needsInfo ? { needsInfo: true } : {}),
  };
}

export const NEEDS_INFO_ASK = "Reporter: add what you saw, where it happens, and what you expected, so the team can act on this.";

export const TEMPLATE_NEXT_STEP: Readonly<Record<TriageKind, string>> = {
  bug: "Planner: reproduce the failure and find its cause in the code.",
  feedback: "Planner: scope the requested change against the code.",
  question: "Answer the reporter in the ticket's thread.",
};

/** The reporter's words `calibrateSeverity` reads: the title, then the description. */
export function issueText(issue: { title: string; description?: string }): string {
  return [issue.title, issue.description ?? ""].join("\n").trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * At most `max` characters, cut with `…`, never mid-word: before a space,
 * else between UAX #29 words (CJK), each only when that keeps at least half
 * the room; else between graphemes (one long URL or hash). No trailing
 * space or `,;:([{/-–—` before the `…`.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 1;
  const end = (segments: Iterable<{ index: number; segment: string }>) => {
    let last = 0;
    for (const { index, segment } of segments) {
      if (index + segment.length > room) break;
      last = index + segment.length;
    }
    return { last, enough: last * 2 >= room };
  };
  const spaced = end(Array.from(text.matchAll(/\s*\S+/g), (match) => ({ index: match.index, segment: match[0] })));
  const worded = spaced.enough ? spaced : end(WORDS.segment(text));
  const kept = text.slice(0, worded.enough ? worded.last : end(GRAPHEMES.segment(text)).last);
  return `${kept.replace(/[\s,;:([{/\-–—]+$/u, "")}…`;
}

/** One TypeSafe call; throws on an outage or a timeout. */
export async function askJev(input: { state: JudgeState; types: readonly IssueTypeRef[]; apiKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): Promise<JevAnswers> {
  const base = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? JEV_TIMEOUT_MS;
  const timed: typeof globalThis.fetch = (url, init) => base(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const answers = await decide({ state: input.state, questions: triageQuestions(input.types), apiKey: input.apiKey, fetch: timed });
  return answers as JevAnswers;
}

export function judgeState(verdict: TriageVerdict, inbound: InboundIssue | undefined): JudgeState {
  if (inbound !== undefined && (inbound.title.trim() !== "" || inbound.description.trim() !== "")) {
    return {
      source: "webhook",
      title: inbound.title.trim(),
      description: inbound.description.trim().slice(0, DESCRIPTION_MAX),
      ...(inbound.reporter === undefined || inbound.reporter === "" ? {} : { reporter: inbound.reporter }),
    };
  }
  return { source: "model", title: verdict.title, description: verdict.summary };
}

export function readAnswers(
  verdict: TriageVerdict,
  source: JudgeState["source"],
  typesSource: "project" | "default",
  types: readonly IssueTypeRef[],
  answers: JevAnswers
): TriageJudgment {
  const type = types.find((candidate) => candidate.name === answers.issueType.choice);
  const severityChoice = answers.severity.choice as TriageSeverity;
  const gateChoice = answers.gate.choice;
  if (type === undefined || !SEVERITIES.includes(severityChoice) || !(GATES as readonly string[]).includes(gateChoice)) {
    return { status: "unavailable", message: "Jev answered outside the triage labels" };
  }
  const typeProbability = probabilityOf(answers.issueType);
  const severityProbability = probabilityOf(answers.severity);
  return {
    status: "judged",
    source,
    types: typesSource,
    type: {
      choice: type.name,
      ...(type.id === undefined ? {} : { id: type.id }),
      probability: typeProbability,
      model: verdict.kind,
      confident: aboveBar(typeProbability),
      jira: "not_written",
      applied: false,
    },
    severity: {
      choice: severityChoice,
      probability: severityProbability,
      model: verdict.severity,
      applied: severityChoice !== verdict.severity && aboveBar(severityProbability),
    },
    gate: {
      choice: gateChoice as (typeof GATES)[number],
      probability: probabilityOf(answers.gate),
      model: verdict.needsInfo === true ? "needsInfo" : "proceed",
    },
  };
}

/**
 * Pure: the verdict record_triage writes, given what happened to the type
 * edit. A type that is not on the ticket leaves the model's kind; severity
 * is a label and applies on confidence alone.
 */
export function settleJudgment(
  verdict: TriageVerdict,
  judgment: TriageJudgment,
  write: IssueTypeWrite | { status: "not_written" } | { status: "eval" }
): { verdict: TriageVerdict; judgment: TriageJudgment } {
  if (judgment.status !== "judged") return { verdict, judgment };
  const onTicket = judgment.type.confident && (write.status === "set" || write.status === "already" || write.status === "eval");
  const type: JudgedType = {
    ...judgment.type,
    jira: judgment.type.confident ? write.status : "not_written",
    ...(write.status === "failed" ? { message: write.message } : {}),
    applied: onTicket,
  };
  return {
    verdict: {
      ...verdict,
      ...(onTicket ? { kind: kindForType(type.choice, verdict.kind) } : {}),
      ...(judgment.severity.applied ? { severity: judgment.severity.choice } : {}),
    },
    judgment: { ...judgment, type },
  };
}

function criterionFor(name: string): string | undefined {
  const key = Object.keys(ISSUE_TYPE_CRITERIA).find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase());
  return key === undefined ? undefined : ISSUE_TYPE_CRITERIA[key];
}

export function probabilityOf(answer: ChoiceAnswer): number {
  const value = (answer.probabilities as Record<string, unknown>)[answer.choice];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The `Judge:` line on the Triage: comment, or undefined when Jev did not
 * answer (the comment then reads exactly as it did before Jev). The desk
 * (factory-desk/agent/lib/triage-comment.ts) parses `(set in Jira; model said X)`.
 */
export function judgeLine(judgment: TriageJudgment): string | undefined {
  if (judgment.status !== "judged") return undefined;
  if (judgment.jevOnly === true) return `Judge: Jev ${[onlyTypePart(judgment.type), `severity ${judgment.severity.choice} ${judgment.severity.probability.toFixed(2)} (Jev only)`].join("; ")}`;
  return `Judge: Jev ${[typePart(judgment.type), severityPart(judgment.severity)].join("; ")}`;
}

/**
 * The backup triage model by name, as Slack and the Triage: comment show it:
 * the host's model (factoryModel over LIGHT_MODEL, so grok-4.6 at fast is
 * `Grok 4.6 Fast`). The platform's `fallbacks` only run when this one is
 * refused, blocked by a team admin ("Model Blocked", July 0.2.13+), or out
 * of capacity before any output. When one does, a backup model triaged and
 * this name is the configured model, not the one that answered.
 */
export function triageModelName(model: FactoryModel): string {
  const param = (id: string) => model.params.find((entry) => entry.id === id)?.value;
  const fast = param("fast") === "true" || param("speed") === "fast";
  const grok = /^grok-(.+)$/i.exec(model.id);
  if (grok !== null) return `Grok ${grok[1]}${fast ? " Fast" : ""}`;
  if (model.id === "auto-smart") return "Cursor Auto";
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i.exec(model.id);
  if (claude !== null) return `Claude ${claude[1]!.charAt(0).toUpperCase()}${claude[1]!.slice(1).toLowerCase()} ${claude[2]}.${claude[3]}`;
  return model.id;
}

/** The model this host's fallback triage turn runs on, by name. */
export function fallbackTriageModel(env: NodeJS.ProcessEnv): string {
  return triageModelName(factoryModel(env, LIGHT_MODEL));
}

/** Jev's confidence in a judged triage, as a whole percent (the lowest of its three answers). */
export function judgmentConfidence(judgment: TriageJudgment): number | undefined {
  if (judgment.status !== "judged") return undefined;
  return jevConfidence([judgment.type.probability, judgment.severity.probability, judgment.gate.probability]);
}

/**
 * Who triaged, for the Triage: comment: `Triaged by: Jev` when every answer
 * cleared the bar, else `Triaged by: <backup model>` with why Jev did not
 * settle it (`Jev was only 50% confident`). The desk reads the name and the
 * percent for its Slack lines; the scores stay on the `Judge:` line.
 */
export function triagedByLine(judgment: TriageJudgment, options: { model?: string } = {}): string {
  const bar = JEV_THRESHOLD.toFixed(2);
  const model = options.model ?? fallbackTriageModel(process.env);
  if (judgment.status === "skipped") return `Triaged by: ${model} (Jev is not configured)`;
  if (judgment.status === "unavailable") return `Triaged by: ${model} (Jev did not settle it: ${cut(oneLine(judgment.message), 160)})`;
  const percent = judgmentConfidence(judgment);
  if (judgment.jevOnly === true) {
    const notes = [percent === undefined ? undefined : `${percent}% confidence`, judgment.severity.cappedFrom === undefined ? undefined : `Jev said ${judgment.severity.cappedFrom}`, `type, severity, and gate all above ${bar}`];
    return `Triaged by: Jev (${notes.filter((note) => note !== undefined).join("; ")})`;
  }
  return `Triaged by: ${model} (${percent === undefined ? `Jev was not above ${bar} on every answer` : `Jev was only ${percent}% confident; not above ${bar} on every answer`})`;
}

/** The lines a Triage: comment ends with: who triaged, then Jev's scores when it answered. */
export function triageRecordLines(judgment: TriageJudgment, options: { model?: string } = {}): string {
  const judge = judgeLine(judgment);
  const by = triagedByLine(judgment, options);
  return judge === undefined ? by : `${by}\n${judge}`;
}

// No model ran, so there is nothing to agree with. The desk reads `Jev only`.
function onlyTypePart(type: JudgedType): string {
  const head = `type ${type.choice} ${type.probability.toFixed(2)}`;
  if (!type.applied) return `${head} (Jira edit failed; Jev only)`;
  return type.jira === "already" ? `${head} (already ${type.choice} in Jira; Jev only)` : `${head} (set in Jira; Jev only)`;
}

function typePart(type: JudgedType): string {
  const head = `type ${type.choice} ${type.probability.toFixed(2)}`;
  if (type.held === true) return `${head} (held back: the report says something is broken now; kept the model's ${type.model})`;
  if (!type.confident) return `${head} (below ${JEV_THRESHOLD.toFixed(2)}, kept the model's ${type.model})`;
  if (!type.applied) return `${head} (Jira edit failed, kept the model's ${type.model})`;
  const where = type.jira === "already" ? `already ${type.choice} in Jira` : "set in Jira";
  const kind = kindForType(type.choice, type.model);
  return kind === type.model ? `${head} (${where}; agreed)` : `${head} (${where}; model said ${type.model})`;
}

// The probability is Jev's own choice's, so a capped one names that choice.
function severityPart(value: JudgedLabel<TriageSeverity>): string {
  const head = `severity ${value.choice} ${value.probability.toFixed(2)}`;
  const said = value.cappedFrom === undefined ? "" : `; Jev said ${value.cappedFrom}`;
  if (value.applied) return `${head} (model said ${value.model}${said})`;
  if (value.choice === value.model) return `${head} (agreed${said})`;
  return `${head} (kept the model's ${value.model}, below ${JEV_THRESHOLD.toFixed(2)}${said})`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 240);
}
