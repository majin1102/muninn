# Observation Extraction Prompt Design Notes

Date: 2026-04-30

## Context

Muninn's observing pipeline is moving toward two complementary memory layers:

- Atomic observations: grounded, self-contained memory points that can enter semantic search directly.
- Observing threads: higher-level topic synthesis built from related observations and source context.

Recent LoCoMo experiments showed that overly specific prompt rules can improve one bad case while reducing the model's ability to make useful judgments. The current direction is to keep observation extraction prompts grounded and explicit, but avoid encoding every edge case as a rule.

## Terminology

Use `Observation Extraction` for the first stage that turns raw turns, sessions, or tool events into atomic observations.

- `Observation Extraction Prompt`: the prompt used by this first extraction stage.
- `Atomic Observation`: the grounded, self-contained memory unit produced by observation extraction.
- `Thread Builder`: the later stage that searches, groups, and links atomic observations into observing threads.
- `Thread Observation` or `Snapshot Synthesis`: the later stage that updates an observing thread's title, summary, observations, and context refs.

Avoid using `observer prompt` for this first stage. It is too broad and can be confused with later thread-level observers or future agent-loop observers.

## Design Principle

Observation extraction prompts should guide the model with a small number of durable quality principles:

- Ground observations directly in the provided conversation or tool/event input.
- Make each observation self-contained enough to be useful without reading the original transcript.
- Attribute facts to the correct subject.
- Preserve useful time, object, owner, scope, and status when available.
- Avoid over-inference about identity, intent, stable preference, or long-term meaning unless explicitly stated or directly entailed.
- Skip greetings, thanks, filler, assistant mechanics, and temporary reactions unless they carry useful information.

The extraction prompt should not try to enumerate every bad case. Doing so pushes the model toward brittle rule execution and can reduce its ability to identify useful memories in new domains.

## External References

### OpenClaw

OpenClaw's `AGENTS.md` template uses a very small memory rule:

- capture what matters;
- store decisions, context, things to remember;
- skip secrets unless asked;
- daily notes are raw logs and `MEMORY.md` is curated long-term memory.

OpenClaw's `memory-lancedb` auto-capture path is also intentionally simple:

- only user messages are considered;
- trigger rules detect explicit memory-like statements such as remember/prefer/like/important/my X is;
- stored memory is close to the source text;
- category detection is lightweight rule-based.

This design has low hallucination risk, but it can miss implicit context, assistant-side confirmations, time normalization, and multi-turn synthesis.

### Honcho

Honcho's deriver prompt is the closest reference for Muninn's observation extraction layer. It asks the model to extract explicit atomic facts, but keeps the instruction surface compact:

- extract facts directly derived from messages;
- transform statements into one or multiple conclusions;
- each conclusion must be self-contained;
- use absolute dates/times when possible;
- properly attribute observations to the correct subject;
- use surrounding messages as context.

The useful part is the focus on atomic, self-contained observations without a large taxonomy or many special-case exclusions.

### SimpleMem

SimpleMem's memory builder emphasizes structured compression:

- generate enough entries to capture all valuable information;
- avoid pronouns and relative time;
- each lossless restatement must be complete and independently understandable;
- include keywords, timestamp, location, persons, entities, and topic.

This is useful for recall quality, but it is more prescriptive than Muninn should be by default. Muninn can borrow the self-contained and lossless-restatement ideas without forcing a large field schema at the atomic observation layer.

### MemoryOS

MemoryOS contains useful examples of concise extraction and profile update prompts, but many prompts are oriented toward user profiling, personality dimensions, and assistant/user trait analysis. Those are higher-risk for Muninn's current goal because they encourage broad inference. They are better treated as optional specialized extraction providers, not as the default observation extraction style.

### Claude-mem

Claude-mem's observation design is useful because it separates the observer shell from domain-specific recording focus.

The core observer role is clear: observe another live session and record what was learned, built, fixed, deployed, configured, or discovered. It explicitly avoids observations about the observing process itself. This is a useful distinction for Muninn: observations should record useful facts, state, context, and changes, not transcript mechanics such as "someone asked" or "the observer analyzed".

Claude-mem's mode files then define what is worth recording for a domain. In code mode, it records durable technical signal such as changed behavior, shipped fixes, configuration changes, and concrete debugging findings. In `code--chill`, the threshold is higher: only record information that would be painful to rediscover. This is a better pattern than hard-coding many edge-case rules into the generic observation extraction prompt.

The most directly reusable part is its fact guidance:

- facts should be concise;
- each fact should be one piece of information;
- facts should be self-contained;
- facts should avoid pronouns;
- facts should include specific details.

Muninn should not copy Claude-mem's full XML schema or code-domain taxonomy by default. Those are appropriate for software-development memory, but too heavy for a general memory system. The useful lesson is to keep a stable extraction role, keep atomic observations self-contained, and let domain-specific modes define their own recording focus when needed.

## Recommended Muninn Direction

Muninn should keep the default observation prompt closer to Honcho plus selected SimpleMem/Claude-mem ideas:

```text
You extract durable memory observations from conversation evidence for future recall.

Record what became useful to know, not the fact that a conversation happened.
Each observation should be grounded, self-contained, and specific.

Prefer observations that capture:
- facts, preferences, plans, decisions, relationships, tasks, entities, or meaningful context
- changes in state, commitments, answers, or recurring patterns
- concrete details that would be hard or annoying to rediscover later

Skip low-value conversational residue:
- greetings, thanks, filler, acknowledgements, routine reactions, or assistant mechanics
- transcript events that do not establish useful future context

Do not infer private identity, stable preference, intent, or long-term meaning unless it is explicitly stated or directly entailed.
```

This prompt keeps three hard constraints:

- grounded;
- self-contained;
- low-inference.

Everything else should be left to the model unless repeated benchmark failures show a stable, generalizable problem.

## Implications for Observing Architecture

Atomic observations should be treated as first-class memory units:

- They can enter `semantic_index` directly.
- They should remain useful even when no observing thread is created.
- They should be updateable or supersedable when later evidence conflicts.
- Thread building should consume observations, not replace them.
- Observing thread snapshots should synthesize related observations into higher-level topic state.

Future pluggability can happen at the observation provider layer, but it is not urgent. A future provider could emulate OpenClaw-style lightweight capture, while Muninn's default provider can use a grounded LLM extraction prompt.

## Cautions

- Do not optimize the default observation extraction prompt only for LoCoMo QA.
- Do not turn every bad case into a new rule.
- Do not force private identity or stable preference inference at the atomic observation layer.
- Do not make gateway routing responsible for deciding final memory value.
- Do not rely only on observing threads for recall; atomic observations should remain searchable.
