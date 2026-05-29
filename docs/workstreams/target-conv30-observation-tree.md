# Conv-30 Target Observation Tree

This document is a manual target shape for validating observer prompt changes.
It is not runtime input and does not replace automated scores.

Baseline run:

- Run: `conv-30-41-42-budget0-top8-hybrid-recover-refs`
- Result: `benchmark/locomo/out/conv-30-41-42-budget0-top8-hybrid-recover-refs.real.json`
- OpenViking: `0.7160` on `conv-30`
- Honcho: `0.6543` on `conv-30`

Validation goal:

- Parent sections carry broad synthesis.
- Leaf sections carry focused, retrievable remembered units with specific refs.
- Broad support or relationship summaries should not absorb concrete advice, event outcomes, plans, source-object reactions, dates, places, or item lists that can form focused leaves.
- Related concrete parts needed to answer one remembered subject should stay together.

## Target Principles

### Parent vs Leaf

Parent sections should summarize scope and relationships:

```md
## Career and dance-studio plans

Jon's career change, studio planning, business preparation, outreach, and support network developed across sessions after he lost his banker job.
```

Leaf sections should be focused and answerable:

```md
### Plans after networking advice <!-- refs: [72f995b52b6f34f8afa8d064, 2331b0ab54ba0b3b65579383] -->

After Gina congratulated Jon on the successful networking night and asked what he planned to do with the advice he got, Jon said he was taking the advice by “sprucing up” his business plan, tweaking his pitch to investors, and working on an online platform to show off the dance studio’s “stuff.”
```

The broad parent can mention networking as part of business development, but the concrete post-networking plan should not be buried at the end of a large strategy leaf.

### Focused Leaf Span

Large leaves are acceptable only when every ref supports one focused remembered subject. A leaf like `Gina supported his studio persistence` should not absorb unrelated concrete plans, advice, event outcomes, or business steps just because they share the same people and topic.

Current problematic example:

```md
### Gina supported his studio persistence

Gina repeatedly encouraged Jon’s dance-studio persistence ... On 21 July 2023, after Gina encouraged him through business setbacks and investor difficulties, Jon thanked her support, said running a business is not easy, and asked how she tackled challenges in her business and whether she had advice...
```

Target split:

```md
## Gina's support for Jon

Gina repeatedly encouraged Jon through studio setbacks and business pressure.

### Encouraged Jon through studio setbacks <!-- refs: [...] -->

Gina told Jon not to give up, said she was there for him, framed setbacks as “opportunities for comebacks,” and repeatedly encouraged him to keep going with the studio.

### Advice request after investor difficulties <!-- refs: [8a1e314be945c3556672784e] -->

After Jon said running a business was not easy and mentioned investor difficulty, he asked Gina how she had tackled challenges in her business and whether she had advice.
```

## Target Nodes For Conv-30

These target nodes are centered on failure patterns from the current run. The exact ids are not important; the expected shape is.

### Jon / Career and dance-studio plans / Lost banker job and chose business

Refs:

- `206a01a5b267617767b1c392`

Target content:

```md
On 20 January 2023, Jon said he had lost his job as a banker on 19 January 2023 and was “gonna take a shot” at starting his own business.
```

Notes:

- Keep `19 January 2023` at full precision.
- This should remain a focused leaf, not be weakened to `January 2023`.

Related QA:

- `conv-30 Q0`: `When Jon has lost his job as a banker?`

### Jon / Career and dance-studio plans / Plans a dance studio

Refs:

- `b2b986b8aa291259f49cb1f9`

Target content:

```md
Jon plans to start a dance studio because he is passionate about dancing, has been into dancing since he was a kid, sees it as his passion and escape, and wants to teach others the joy that dancing brings him. He described a studio by the water as his “ideal dance studio” and hoped to find an inspiring place like it.
```

Notes:

- This leaf should cover the initial business decision and motivation.
- It should not absorb later studio-space requirements, marketing steps, or networking plans.

Related QA:

- `conv-30 Q4`: `Why did Jon decide to start his dance studio?`

### Jon / Career and dance-studio plans / Searching for the right studio space

Refs:

- `8f76b97780ab3270dcb43336`
- Optionally `698fa5bbe1a829940d0cddf2`, `4b9615dec7455129c9774447` if the retained content includes continued search/determination.

Target content:

```md
Jon wanted an ideal dance studio by the water and later said he had found a promising place downtown with great natural light. Before deciding, he wanted to check the size and floor quality because “we need a good dance floor with enough bounce for me & my students to dance safely.” He wanted Marley flooring because it is grippy while still allowing movement, tough, and easy to keep clean.
```

Notes:

- Keep the concrete parts together: `by the water`, `natural light`, `floor quality`, `Marley flooring`.
- Do not split these across broad studio-plan and studio-search leaves if the query target is the ideal studio.

Related QA:

- `conv-30 Q5`: `What Jon thinks the ideal dance studio should look like?`

### Jon / Dance interests and projects / Rehearsing for February 2023 festival

Refs:

- `33e3f28019aeb680340c3832`
- `2a2d0f520cafd46673a5003d` only if the after-festival reflection remains in this leaf.

Target content:

```md
Jon rehearsed with a small group of dancers after work, doing “all kinds of dances, from contemporary to hip-hop.” In January 2023, they were finishing choreography to perform at a nearby festival in February 2023.
```

Notes:

- Keep the event time `February 2023` near `festival`.
- Do not let later May 2023 studio competition/outreach language compete with this festival leaf.

Related QA:

- `conv-30 Q6`: `When is Jon's group performing at a festival?`

### Jon / Dance interests and projects / Festival dancers photo

Refs:

- `33e3f28019aeb680340c3832`

Target content:

```md
When Jon shared a photo of a group of dancers in white dresses on a stage, Gina asked whether the dancers in the photo were his at the festival and said they were “so graceful.” Jon confirmed they were the ones performing at the festival, had been practicing hard, and would impress with their grace and skill.
```

Notes:

- The source object is the photo and the dancers in it.
- Preserve the speaker-target relation: Gina said the dancers looked graceful.
- This should not be collapsed into broad choreography, dance passion, or festival outcome.

Related QA:

- `conv-30 Q43`: `What do the dancers in the photo represent?`
- `conv-30 Q44`: `What does Gina say about the dancers in the photo?`

### Jon / Travel / Visited Paris and Rome

Refs:

- `c4874303c691d7a73afca6bb`
- `5e570f8950aa17fe6b16d094`

Target content:

```md
Jon visited Paris on 28 January 2023. He later took a short trip to Rome in the week before 19 June 2023 to clear his mind while continuing to work on his business.
```

Notes:

- If a query asks for cities Jon visited, `Paris` and `Rome` need to be recoverable together or as adjacent focused leaves under the same travel parent.

Related QA:

- `conv-30 Q29`: `Which cities has Jon visited?`

### Jon / Career and dance-studio plans / Promotion events

Refs:

- `10019b8c0c84d77074cfdaf9`
- `a8844be20f5a0c4c259f8dcb`
- `a0a5cca7af1f60a9813eb87b`
- Optionally `c4cefcc44f0603846ec48216`, `44a1d3cda5217a7d13ba8f73` if retained content includes the event details.

Target content:

```md
Jon promoted his dance-studio venture through several events: he showed off the studio at a fair on 24 April 2023 and got “some possible leads,” hosted or planned a dance competition in May 2023 to showcase local talent and bring attention to the studio, and later attended networking events where he met investors and got advice.
```

Notes:

- Keep the event list together because it answers one remembered subject.
- Do not let the fair disappear inside a broad business hardship or support leaf.

Related QA:

- `conv-30 Q24`: `Which events has Jon participated in to promote his business venture?`

### Jon / Career and dance-studio plans / Mentored on 15 June 2023

Refs:

- `4d2a92de4da76de6ab5a3530`

Target content:

```md
Jon was mentored by an “amazing business dude” on 15 June 2023; he found it “really inspiring” and said he was “even more pumped” to chase his dreams.
```

Notes:

- Keep `15 June 2023` as the event date.
- Do not rewrite to the conversation date or adjacent date.

Related QA:

- `conv-30 Q26`: `When did Jon receive mentorship to promote his venture?`

### Jon / Career and dance-studio plans / Plans after networking advice

Refs:

- `72f995b52b6f34f8afa8d064`
- `2331b0ab54ba0b3b65579383`

Target content:

```md
After Gina congratulated Jon on the successful networking night and asked what he planned to do with the advice he got, Jon said he was taking Gina’s advice by “sprucing up” his business plan, tweaking his pitch to investors, and working on an online platform to show off the dance studio’s “stuff.”
```

Notes:

- This focused leaf should exist separately from broad planning strategy and broad outreach.
- Keep all three concrete parts together: business plan, investor pitch, online platform.

Related QA:

- `conv-30 Q80`: `What plans does Jon have after receiving advice at the networking event?`

### Gina / Dance / Regionals win with Finding Freedom

Refs:

- `a3f80ec9559fb277c3154f7a`

Target content:

```md
Gina said she used to compete in a few dance competitions and shows. Her favorite memory was when her team won first place at regionals at age fifteen with a contemporary piece called “Finding Freedom,” which she described as “really emotional and powerful.” Winning felt like “an awesome feeling of accomplishment.”
```

Notes:

- Keep `won first place at regionals` directly attached to `favorite memory`.
- This should remain distinct from general dance stress relief or studio memories.

Related QA:

- `conv-30 Q27`: `Did Jon and Gina both participate in dance competitions?`
- `conv-30 Q41`: `What was Gina's favorite dancing memory?`

### Gina / Dance / Dance contest trophy

Refs:

- `c48e6c8e4fd785261a6ab137`

Target content:

```md
Gina shared a photo of one of her trophies from a dance contest and called the trophy a reminder of the hard work, dedication, and joy dance brings.
```

Notes:

- Keep `trophy` as the item received.
- Do not weaken this into winning, first place, or general accomplishment.

Related QA:

- `conv-30 Q61`: `What did Gina receive from a dance contest?`

### Gina / Work and business / Started clothing store

Refs:

- `691a31188542a4dd127e4c3d`
- `8d525cd70623b711961ba00c`

Target content:

```md
Gina started the online clothing store because she is passionate about fashion trends and finding unique pieces, wanted to blend her love for dance and fashion, and after losing her job wanted “to take control of my own destiny.”
```

Notes:

- Keep both motivation chains: fashion/unique pieces and job loss/control of destiny.
- Do not let the job-loss reason erase the fashion reason.

Related QA:

- `conv-30 Q17`: `Why did Gina decide to start her own clothing store?`

### Gina / Work and business / Store promotion methods

Refs:

- `d54e4a9c1f034defcdaa23e9`
- `9407fb4d5fbb34ea872e7c00`
- `0fe6418706072c19fb605687`
- Any extraction that contains limited-edition sweatshirts if present in the run.

Target content:

```md
Gina promoted and grew her clothing store by teaming up with a local artist for cool designs, making or offering unique fashion pieces, using new offers and promotions on the online store, thinking about fashion bloggers/influencers and more ads, and developing a video presentation to teach how to style her pieces.
```

Notes:

- Keep concrete promotion methods together because they answer one remembered subject.
- If a limited-edition sweatshirt extraction exists, it should be included here rather than buried in product inventory.

Related QA:

- `conv-30 Q23`: `How did Gina promote her clothes store?`

### Gina / Work and business / Store customer experience

Refs:

- `a71f634e-db1f-455a-ac3d-5452d5fcf86a`
- `9db243382b1260873d23bbfc` only if Jon's customer-experience advice remains in the same leaf.

Target content:

```md
Gina wanted her store to feel cozy and comfortable for customers, with furniture that looked great and was comfortable. Jon said creating a special shopping experience was key to making customers feel welcome and want to come back.
```

Notes:

- Keep `cozy and comfortable` distinct from later `cool oasis` wording.
- Keep Jon's `welcome and coming back` advice as the answer-bearing phrase if it is retained here.

Related QA:

- `conv-30 Q49`: `What did Gina want her customers to feel in her store?`
- `conv-30 Q52`: `What did Jon say about creating a special experience for customers?`

### Gina / Work and business / Business advice to Jon

Refs:

- `538f8cfb5d102a0f9fe755a0`
- `3e9e9a5725063505aaa2b90a`
- `7329601f552bbb67802dfceb`
- Other extractions only if they are direct Gina-to-Jon business advice.

Target content:

```md
Gina advised Jon to use social media, especially Instagram and TikTok, to reach a younger crowd; post dance clips or dance-related content; collaborate with local influencers or dance communities; stay passionate, focused, and resilient; stay open to learning and improving; and not be scared to reach out to people in his field for help and contacts because networking had helped her.
```

Notes:

- Do not mix Jon's advice to Gina into Gina's advice to Jon.
- Separate direct business advice from broad encouragement.

Related QA:

- `conv-30 Q57`: `What advice does Gina give to Jon about running a successful business?`

### Jon / Career and dance-studio plans / Advice to Gina on business success

Refs:

- `9db243382b1260873d23bbfc`

Target content:

```md
When Gina asked for advice or tips on running a successful business, Jon told her that brand identity is key and should stand out. He also advised her to build relationships with customers by letting them know she cares, and to stay positive and motivate others because her energy would be contagious.
```

Notes:

- This is Jon's advice to Gina, not Gina's advice to Jon.
- The leaf path should make direction clear.

Related QA:

- Useful as a counterexample for `conv-30 Q57`.

### Jon and Gina / Shared entrepreneurship pattern

Refs:

- `206a01a5b267617767b1c392`
- `8d525cd70623b711961ba00c` or another Gina job-loss/business-start extraction.

Target content:

```md
Jon and Gina both lost jobs and decided to start their own businesses: Jon lost his banker job on 19 January 2023 and decided to take a shot at starting his own business, while Gina lost her DoorDash job in January 2023 and started her own online clothing store.
```

Notes:

- This cross-entity relation is useful but should be a focused relation leaf, not inferred only from separate Jon/Gina leaves at recall time.

Related QA:

- `conv-30 Q3`: `What do Jon and Gina both have in common?`

## Anti-Targets

Avoid producing leaves like these as searchable leaves:

```md
### Gina supported his studio persistence

Gina repeatedly encouraged Jon's studio journey across many sessions, supported his setbacks, praised his passion, reacted to his opening, discussed business advice, and celebrated his progress...
```

Why:

- It is too broad and will win many searches because it contains many query terms.
- It mixes encouragement, business advice, event reactions, and plan updates.
- It should be a parent summary with focused child leaves.

Avoid burying concrete answerable details like this:

```md
### Planning studio business strategy

Jon used books, visuals, mentorship, investor work, written plans, and new tools...
After the networking event, he spruced up his business plan, tweaked investor pitch, and worked on online platform.
```

Why:

- `Plans after networking advice` is a focused remembered subject.
- If left at the end of a broad strategy leaf, recall and answer extraction are unstable.

Avoid over-splitting like this:

```md
### Spruced up business plan
### Tweaked investor pitch
### Worked on online platform
```

Why:

- These three are concrete parts of one remembered answer: Jon's plans after networking advice.

