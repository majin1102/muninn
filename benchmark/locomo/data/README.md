# LoCoMo Vendored Data

This directory vendors benchmark data copied from the official LoCoMo repository:

- Source repository: <https://github.com/snap-research/locomo>
- Upstream data path: `data/`

Vendored files in this directory currently include:

- `locomo10.json`
- `msc_personas_all.json`
- `multimodal_dialog/`
- `LOCOMO_LICENSE.txt`

These files are included so the Muninn LoCoMo benchmark can run without a
path dependency on a sibling checkout such as `../locomo`.

License and compliance note:

- The upstream LoCoMo repository ships its data under `CC BY-NC 4.0`
- A copy of the upstream license is included as `LOCOMO_LICENSE.txt`
- Attribution to the upstream LoCoMo repository must be preserved
- The `NC` term means redistribution and use are limited to non-commercial use

Before reusing or redistributing these vendored files outside this repository,
review `LOCOMO_LICENSE.txt` and confirm the intended use is compatible with the
upstream license terms.
