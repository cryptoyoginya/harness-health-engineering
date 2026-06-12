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
   can't be attributed. This is the single most violated rule in casual self-experiments.
3. **Baseline.** A measured "before", ideally a median over a stabilisation week, not a single day.
4. **Intervention period** with a fixed duration (typically 2–3 weeks).
5. **Pre-defined success criterion.** The threshold is written *before* the data arrives, to prevent
   post-hoc rationalisation (e.g. "+30 min sleep OR +10 pp recovery").
6. **Verdict → rule.** At the end: `merge` (it worked → the change becomes a standing rule in
   `CLAUDE.md`) or `revert` (it didn't → drop it, record why). Where feasible, a **washout** or
   reversal period strengthens the inference.

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

The discipline is the product. The data is just the raw material.
