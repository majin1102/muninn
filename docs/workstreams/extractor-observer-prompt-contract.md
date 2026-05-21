# Extractor / Observer Prompt Contract

## Extractor Contract

Extractor produces memory units under `## Extractions`.

Each memory unit format is:

```text
<!-- refs: [turn:x, turn:y] -->
[Entity] <main central person>
[Context] <optional local source context>
[Extraction] <complete remembered content>
```

Rules:

- `[Entity]` is the single main person this memory is centrally about; choose the owner of the remembered content, not every person mentioned.
- `[Extraction]` captures complete remembered content in observer-view wording, including the original remembered object, facts, descriptions, and causal relationships.
- Keep each `[Extraction]` body focused and under 300 words; if preserving meaning would exceed that, split it into multiple memory units.
- `[Context]` briefly locates the source context needed to understand the extraction.

Example:

```text
<!-- refs: [turn:1] -->
[Entity] Jamie
[Context] Alex asked Jamie what they wanted to focus on next quarter.
[Extraction] Jamie plans to focus next quarter on improving onboarding for new users.
```

## Observer Contract

Observer rewrites observation tree leaves from source extraction units.

Leaf budget:

- Keep the whole leaf under 1000 words and within 5 source extractions; exceed these only when splitting would break an inseparable memory or lose recall-critical meaning.
- When splitting, create narrower sibling leaves by content or subject, or promote the broad scope into child leaves when nested structure is clearer.
- Name sections by remembered content, not by date, session, turn order, or catch-up structure.
- Group extractions into one leaf only when they would naturally be read together as one coherent memory section; do not group by date, session, speaker pair, or broad topic alone.

Leaf format:

```text
Synthesis paragraph.

- [extraction_id] rewritten remembered content
- [extraction_id] rewritten remembered content
```

Rules:

- The synthesis paragraph summarizes how the linked extractions fit together; it should not replace their source facts.
- Lines starting with `-` are reserved for extraction-linked bullets; write all other leaf text as paragraphs.
- Each bullet uses `- [extraction_id] rewritten remembered content` for one source extraction; preserve the source extraction's answerable content at its original precision, keeping only the context needed to understand it and removing only filler or repeated wording.
- When rewriting a leaf, resolve conflicts, corrections, repetitions, and complementary details across extractions; do not mechanically rewrite each extraction or leave contradictory duplicates side by side.
- Keep extraction ids in the leaf text for duplicate filtering; recall uses the leaf content as written.

Example:

```text
# Atlas
## Product Direction
### Onboarding metric focus
Atlas narrowed its product direction from a broad activation-versus-retention discussion into an onboarding-focused first-run experience plan.

- [ext-uuid1] The team compared activation and retention as possible product priorities for Atlas.
- [ext-uuid2] Atlas chose to focus on onboarding metrics and first-run product value after the comparison.
```
