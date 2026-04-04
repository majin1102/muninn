# LoCoMo Data Source

This directory now keeps only the attribution and license material for LoCoMo.
The benchmark payload itself is downloaded on demand from a pinned commit in
the maintained fork and cached under `benchmark/locomo/.cache/data/`.

- Pinned source repository: <https://github.com/majin1102/locomo>
- Pinned source commit: `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`
- Upstream data path in the fork: `data/`
- Download helper: `benchmark/locomo/scripts/fetch-data.sh`

The download script currently fetches and checksum-verifies:

- `locomo10.json`
- `msc_personas_all.json`
- `multimodal_dialog/example/agent_a.json`
- `multimodal_dialog/example/agent_b.json`

License and compliance note:

- The upstream LoCoMo repository ships its data under `CC BY-NC 4.0`
- A copy of the upstream license is included as `LOCOMO_LICENSE.txt`
- Attribution to the upstream LoCoMo repository must be preserved
- The `NC` term means redistribution and use are limited to non-commercial use

Before reusing or redistributing these vendored files outside this repository,
review `LOCOMO_LICENSE.txt` and confirm the intended use is compatible with the
upstream license terms.
