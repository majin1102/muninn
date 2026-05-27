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
- Create memory units for reusable remembered content: facts, preferences, decisions, plans, constraints, state changes, relationships, important feedback, unresolved findings, or working context.
- Skip greetings, closings, filler, and turn-management text unless they carry remembered content.

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
- Keep the synthesis paragraph under 300 words.
- When splitting, create narrower sibling leaves by content or subject, or promote the broad scope into child leaves when nested structure is clearer.
- Name sections by remembered content, not by date, session, turn order, or catch-up structure.
- Group extractions into one leaf only when they would naturally be read together as one coherent memory section; do not group by date, session, speaker pair, or broad topic alone.

Leaf format:

```text
Synthesis paragraph.

- [extraction_id]
- [extraction_id] rewritten content
- [extraction_id1, extraction_id2] resolved content
```

Rules:

- The synthesis paragraph summarizes how the linked extractions fit together; it should not replace their source facts.
- Lines starting with `-` are reserved for extraction-linked bullets; write all other leaf text as paragraphs.
- Use `- [extraction_id]` by default when the source extraction does not need observer rewriting; the system will materialize the original Context and Extraction during persistence.
- Use `- [extraction_id] rewritten content` only when one source needs added context, disambiguation, or clearer wording.
- Use `- [extraction_id1, extraction_id2] resolved content` only when multiple sources conflict, correct, duplicate, or strongly complete each other; resolved content is required.
- When writing rewritten or resolved content, preserve the source extraction's answerable content at its original precision, keeping only the context needed to understand it and removing only filler or repeated wording.
- Keep extraction ids in the leaf text for duplicate filtering; persisted observations are materialized before recall.

Example:

```text
# Atlas
## Product Direction
### Onboarding metric focus
Atlas narrowed its product direction from a broad activation-versus-retention discussion into an onboarding-focused first-run experience plan.

- [ext-uuid1]
- [ext-uuid2]
```
