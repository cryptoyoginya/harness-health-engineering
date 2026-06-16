# Methodology — the research layer

This document is the scientific backbone of the project. It explains *why* the system is built the way
it is, in plain language but without hand-waving. The short version: **most self-tracking fails not for
lack of data, but for lack of method.** We borrow the method from clinical and behavioural science and
run it on a sample size of one — you.

## 1. The problem with consumer health tech

- **Correlation, not causation.** "You sleep worse on days you drink" is a correlation. It can't tell
  you whether alcohol *caused* it or whether both were caused by a stressful day. Acting on correlations
  is guessing with extra steps.
- **Surrogate endpoints replace the real goal.** Recovery %, HRV and sleep scores are *proxies* for
  what you actually want (a good life). Optimise the proxy and you hit **Goodhart's law**: "when a
  measure becomes a target, it ceases to be a good measure." People grind their HRV up while their life
  quietly gets worse.
- **Single domain.** A wrist wearable sees physiology and nothing else — not your calendar, your work,
  your relationships, your supplement doses, your bloodwork. The most important drivers of how you feel
  live *outside* its sensor.
- **No memory, no synthesis.** A feed of daily numbers is not knowledge. Knowledge is the pattern across
  months, interrogable in plain language.

## 2. The method: n-of-1 trials

The core research instrument is the **n-of-1 trial** — a single-subject experimental design, a
recognised methodology in personalised medicine for deciding whether an intervention works *for this
individual*. Each experiment (`05_decisions/experiments/`) is pre-registered with:

1. **Hypothesis** — a specific causal claim ("caffeine after 14:00 cuts deep sleep → lowers recovery → lowers mood").
2. **One variable.** Exactly one thing changes; everything else is held steady — otherwise the effect
   can't be attributed. This is the single most violated rule in casual self-experiments, so it is
   enforced at the system level too: **only one experiment runs at a time** (parallel interventions on
   one body confound each other — `MAX_ACTIVE = 1` in `scripts/experiments.mjs`).
3. **Baseline.** A measured "before" — a median over a *stabilisation* week, not a single day, and not
   taken from a low point (see regression to the mean, §2a).
4. **Intervention period** with a fixed duration (typically 2–3 weeks).
5. **One pre-defined primary metric + criterion.** Pick *one* outcome metric and write its threshold
   *before* the data arrives. The threshold must clear the metric's ordinary week-to-week variability
   (a "+10 pp recovery" win is meaningless if recovery already swings ±8 pp week to week). Secondary
   metrics may be watched, but the **verdict is read off the primary one only** — a criterion that
   fires on "metric A *OR* metric B *OR* C" is multiple comparisons in disguise and manufactures false
   positives.
6. **Verdict → rule, via the rubric below.** At the end: `merge` (it worked → the change becomes a
   standing rule in `CLAUDE.md`) or `revert` (it didn't → drop it, record why). Where feasible, a
   **washout / reversal** period (revert the variable, check the effect disappears) is the default — it
   is what separates a causal claim from a correlation.

### 2a. The three traps a verdict must clear

The n-of-1 method is strong, but a careless verdict re-imports exactly the errors it was meant to kill:

- **Regression to the mean.** Experiments are usually started *because things got bad* (red recovery, a
  low week). Things then drift back toward your normal *on their own* — and a naive verdict credits the
  intervention. Guard: baseline from a stable week, not a trough; demand an effect larger than normal
  variability; prefer a washout that re-creates the effect on demand.
- **Multiple comparisons.** Many metrics × many concurrent experiments = something will look
  significant by chance. Guard: one active experiment, one primary metric, one pre-registered threshold.
- **Unblinded expectation.** You know what you changed, so motivation and placebo move subjective
  scores. Guard: lean on objective primary metrics where possible, and on the washout/reversal.

### 2b. Verdict rubric — `merge` only if all hold

A result is promoted to a standing rule **only when every box is checked** (otherwise `revert` or
extend, and say why):

1. The **primary** metric crossed its **pre-registered** threshold (not a secondary picked after the fact).
2. The effect is **larger than the baseline's ordinary week-to-week noise**.
3. **Regression to the mean** is ruled out (stable baseline, not a trough).
4. A **washout/reversal** reproduced the effect — or its absence is logged and the confidence lowered.
5. **Confounders** (slips, illness, life events, cycle, season) are named; uncontrolled ones → `UNKNOWN`.

This turns "I tried a thing once" into evidence that compounds. The headline output is a sentence no
wearable will ever produce: *"creatine moved nothing for you over three weeks — stop paying for it."*

## 3. Outcome over proxy: the north-star

The top-level metric is not a body score. It is **"is my life actually better?"** — captured weekly as
a single integral 1–5 with one sentence, and quarterly across six slow-moving dimensions (emotion,
connection, body, meaning, autonomy, growth). Body data are **instruments in service of that outcome**,
never the target. The system explicitly flags **metric-tyranny**: when proxies rise while life-quality
stalls or falls, that is treated as a failure, not a success. (See `skills/health-life-review.md`.)

A single honest "how was life this week?" rating is used deliberately instead of summing many
sub-scores: people integrate wellbeing holistically, and one sincere judgement is usually more valid
than an arithmetic of parts.

## 4. Epistemic discipline: separating observation from interpretation

Every non-trivial statement carries a label — `FACT`, `INFERENCE`, `ASSUMPTION`, `UNKNOWN`, `RISK`,
`RECOMMENDATION` — and cites the source record. This is evidence-grading applied to a personal log, and
it mirrors the cognitive-behavioural move of splitting an **event** from its **interpretation**. It
directly prevents the most common reasoning bug in self-tracking: reading a physiological dip
(undersleep) as an existential one ("something is wrong with my life") — and vice versa. The
`health-attribution` skill ("is it me or my biology?") operationalises exactly this.

## 5. Confounding and cross-domain causality

Because the record spans body *and* life, the system can chase causal chains a single-domain tracker
cannot see — e.g. *"worst recovery follows high-meeting days, not bad sleep."* Confounders are named
explicitly (the `UNKNOWN` label exists for this), and the remedy for an unresolved confound is to
**design an experiment**, not to assert a conclusion.

## 6. Capture and retrieval

- **Capture** mixes objective auto-ingest (Whoop API) with subjective daily logging — a lightweight form
  of *ecological momentary assessment* (mood/energy/events recorded in the moment, not reconstructed
  later).
- **Retrieval** is on-device hybrid RAG: dense embeddings (`multilingual-e5-small`) + sparse BM25
  (SQLite FTS5), fused with Reciprocal Rank Fusion, over your own longitudinal record. Synthesis runs
  under strict citation rules so every claim is traceable to a record.

## 7. Honest limitations

- **n = 1.** Findings are about *you*, not a population. That is the point, but it means no
  generalisability and wide uncertainty until data accumulates (weeks, not days).
- **Rarely blinded.** Most self-experiments carry placebo/expectation effects; we mitigate with
  pre-registered criteria and, where possible, reversal periods — but we don't pretend it's a
  double-blind RCT.
- **Observational by default.** Outside a running experiment, relationships are correlational and are
  labelled as such (`INFERENCE`, not `FACT`).
- **Not medicine.** The system never diagnoses or treats. Worrying signals resolve to one
  recommendation: see a specialist.

## 8. For clinicians — the evidence pedigree

Plainly: this is **not a medical device, not diagnostic, not regulated clinical decision support.** It is
a structured **n-of-1 self-experimentation and self-management** instrument that enforces a recognised
methodology and produces an auditable, cited record a clinician can read. Defend the *method*, not the app.

**Why the method has standing in evidence-based medicine**

- **N-of-1 trials are a recognised design, not a hobby.** In the OCEBM 2011 Levels of Evidence, the
  n-of-1 RCT is ranked **Level 1 for an individual treatment decision** — when the question is "does this
  work for *this* person," it outranks population RCTs. Foundational and methodological sources: Guyatt
  et al. (*NEJM* 1986); the AHRQ *Design and Implementation of N-of-1 Trials: A User's Guide* (Kravitz &
  Duan, 2014); Nikles & Mitchell, *The Essential Guide to N-of-1 Trials in Health* (Springer, 2015);
  reporting standard **CENT 2015** (CONSORT extension, Vohra et al., *BMJ* 2015). The validity-bearing
  design elements — pre-registered hypothesis and threshold, single variable, stable baseline,
  washout/reversal — are exactly what §2–2b enforce.
- **Outcome over surrogate is the conservative position.** Recovery/HRV are surrogate endpoints, and
  medicine itself warns that surrogates don't reliably track real outcomes. Anchoring on a patient-centred
  outcome aligns with the **patient-reported outcome (PRO)** tradition (FDA PRO guidance, 2009) and
  validated wellbeing instruments such as the **WHO-5** (Topp et al., 2015).
- **Momentary capture** of mood/energy/events is a lightweight **ecological momentary assessment**
  (Shiffman, Stone & Hufford, *Annu Rev Clin Psychol* 2008), reducing recall bias vs retrospective recall.
- **Evidence grading** (`FACT`/`INFERENCE`/`ASSUMPTION`/`UNKNOWN`) applies evidence-appraisal logic to a
  personal log and mirrors the cognitive-behavioural separation of event from interpretation.

**How to position it in a clinical conversation**

1. It **augments, not replaces** care — it hands the clinician a clean, pre-registered protocol plus data
   ("here is the hypothesis, the criterion fixed before the data, and the response"), not "I think it helped."
2. It **enforces discipline** ordinary self-tracking lacks: one variable, one primary metric, a threshold
   set in advance, a verdict rubric (§2b).
3. It is **transparent and auditable** — plain Markdown, every claim cited — unlike black-box wellness apps.
4. It is **explicitly non-diagnostic**, with a hard escalation rule: any worrying signal → see a specialist.

**Stated limits (see §7) are part of the pitch.** n = 1 (no generalisability), rarely blinded
(placebo/expectation), consumer-grade sensors (trends, not diagnostics), and LLM synthesis that is
citation-constrained but not infallible. Naming these is what makes the case evidence-based, not promotional.

### References

- OCEBM Levels of Evidence Working Group. *The Oxford 2011 Levels of Evidence.* Oxford Centre for Evidence-Based Medicine.
- Guyatt G, Sackett D, Taylor DW, et al. *Determining optimal therapy — randomized trials in individual patients.* N Engl J Med. 1986;314(14):889–892.
- Kravitz RL, Duan N, eds. *Design and Implementation of N-of-1 Trials: A User's Guide.* AHRQ Publication No. 13(14)-EHC122-EF. 2014.
- Nikles J, Mitchell G, eds. *The Essential Guide to N-of-1 Trials in Health.* Springer; 2015.
- Vohra S, Shamseer L, Sampson M, et al. *CONSORT extension for reporting N-of-1 trials (CENT) 2015.* BMJ. 2015;350:h1738.
- US FDA. *Guidance for Industry: Patient-Reported Outcome Measures.* 2009.
- Topp CW, Østergaard SD, Søndergaard S, Bech P. *The WHO-5 Well-Being Index: a systematic review.* Psychother Psychosom. 2015;84(3):167–176.
- Shiffman S, Stone AA, Hufford MR. *Ecological momentary assessment.* Annu Rev Clin Psychol. 2008;4:1–32.
- Strathern M. *'Improving ratings': audit in the British University system.* European Review. 1997;5(3):305–321. (Goodhart's law.)

> Citations are given as commonly referenced; verify exact pages/edition before any formal presentation.

---

The discipline is the product. The data is just the raw material.
