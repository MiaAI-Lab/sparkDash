# Third-party notices

sparkDash itself is licensed under the Apache License 2.0 (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)).
It includes or depends on the following third-party work. Each keeps its own license.

## Bundled in the web UI and the server

| Package | Version | License | Copyright |
|---|---|---|---|
| [react](https://www.npmjs.com/package/react) | 19.2.7 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [react-dom](https://www.npmjs.com/package/react-dom) | 19.2.7 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [@dnd-kit/core](https://www.npmjs.com/package/@dnd-kit/core) | 6.3.1 | MIT | Copyright (c) 2021, Claudéric Demers |
| [@dnd-kit/sortable](https://www.npmjs.com/package/@dnd-kit/sortable) | 10.0.0 | MIT | Copyright (c) 2021, Claudéric Demers |
| [@dnd-kit/utilities](https://www.npmjs.com/package/@dnd-kit/utilities) | 3.2.2 | MIT | Copyright (c) 2021, Claudéric Demers |
| [tailwindcss](https://www.npmjs.com/package/tailwindcss) | 4.3.2 | MIT | Copyright (c) Tailwind Labs, Inc. |
| [express](https://www.npmjs.com/package/express) | 5.2.1 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| [ws](https://www.npmjs.com/package/ws) | 8.21.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors |
| [undici](https://www.npmjs.com/package/undici) | 8.9.0 | MIT | Copyright (c) Matteo Collina and Undici contributors |
| [dotenv](https://www.npmjs.com/package/dotenv) | 17.4.2 | BSD-2-Clause | Copyright (c) 2015, Scott Motte |

## Fonts

The Geist and Geist Mono fonts (served from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`)
are bundled in the web UI. Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font).
Licensed under the SIL Open Font License, Version 1.1, reproduced below.

```
Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Icon

The lightning-bolt shape used in the sparkDash logo and favicon follows the "zap" icon from
[Feather](https://github.com/feathericons/feather) (MIT License, Copyright (c) 2013-2017 Cole Bemis).

## Data

`server/collectors/data/gsm8k-200.json` (GSM8K, Copyright (c) 2021 OpenAI, MIT) and
`server/collectors/data/mmlu-285.json` (MMLU, Copyright (c) 2020 Dan Hendrycks, MIT). See
[server/collectors/data/NOTICE.md](./server/collectors/data/NOTICE.md) for the full notices.

## Not bundled, but used or referenced

- [tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench) by SeraphimSerapis (MIT) is installed and run on your own Spark when you use Tool Eval Bench. Its scenario methodology is adapted from ToolCall-15 by stevibe (MIT), and it credits the Typed Decisions dataset from the LocalLLaMA organization (Apache 2.0).
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) by Nous Research is monitored and updated over SSH when you enable it.
- The Instruction following category is inspired by IFEval (Zhou et al., Google). No IFEval code or data is included.
- The health findings (thermal, low power, Xid, memory, link speed) were inspired by [spark-doctor](https://github.com/joeynyc/spark-doctor) by joeynyc (MIT). No code from it is included.
