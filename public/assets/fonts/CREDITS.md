# Fonts

Every face here is licensed under the [SIL Open Font License 1.1](OFL.txt)
and is served from this repository. The site makes no font request to a
third party.

The web files are subsets: Latin-1, Latin Extended-A, Georgian, general
punctuation, and the currency and maths marks the interface types (₾, −,
×, …). Everything else — Arabic, Devanagari, Hebrew, Thai, Cyrillic,
Greek — is dropped, which is most of the weight. All eight files
together come to 197 KB.

## Casino Sans — interface text

- **Derived from:** [FiraGO](https://github.com/bBoxType/FiraGO) 1.001
- **Designers:** Georgian by **Akaki Razmadze** and **Anja Meiners**;
  FiraGO by bBox Type GmbH, extending Fira Sans (Erik Spiekermann,
  Ralph du Carrois, Anja Meiners, Botio Nikoltchev)
- **Copyright:** Digitized data copyright 2012–2018 for FiraGO, bBox
  Type GmbH and HERE Europe B.V. All rights reserved, with Reserved Font
  Name "Fira"
- **Licence:** SIL OFL 1.1
- **Weights:** 400, 600, 700, 800 (Roman)

## Casino Mono — every number

- **Derived from:** [IBM Plex Mono](https://github.com/IBM/plex) 2.3,
  by Mike Abbink and Bold Monday
- **Copyright:** Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"
- **Licence:** SIL OFL 1.1
- **Weights:** 500, 700 (Latin)

## Noto Serif Georgian — game display type

- **Source:** [notofonts/georgian](https://github.com/notofonts/georgian) 2.003
- **Copyright:** Copyright 2022 The Noto Project Authors
- **Licence:** SIL OFL 1.1
- **Weights:** 600, 800 (Georgian, including Mtavruli)

## Why two of them are renamed

OFL 1.1 reserves a font's name against modified versions, and the
[OFL FAQ 2.6](https://openfontlicense.org/ofl-faq/) is explicit that
subsetting a webfont counts as modification — "removing any parts of the
font when delivering a webfont to a browser, including unused glyphs and
smart font code, is considered modification". FiraGO reserves "Fira" and
IBM Plex reserves "Plex", so their subsets cannot ship under those names.
They are **Casino Sans** and **Casino Mono** here, renamed in the font
binaries as well as in the CSS. Their copyright and licence strings are
untouched, as the licence requires.

Noto Serif Georgian reserves no name, so it keeps its own.

## Rebuilding

The subsets were produced with `fonttools` — not a project dependency,
and not needed to run or develop the site. The output is committed.

```
pyftsubset FiraGO-Regular.ttf \
  --unicodes=U+0000-00FF,U+0100-017F,U+0192,U+02BB-02BC,U+02C6,U+02DA,U+02DC,\
U+10A0-10FF,U+1C90-1CBF,U+2000-206F,U+20A0-20BF,U+2122,U+2190-2193,\
U+2212,U+2215,U+2713,U+2717,U+25CF,U+FEFF \
  --layout-features=kern,liga,calt,locl,ccmp,mark,mkmk,onum,tnum \
  --flavor=woff2 --desubroutinize --name-IDs=0,1,2,3,4,5,6,7,13,14 \
  --output-file=casino-sans-400.woff2
```

Noto Serif Georgian and IBM Plex Mono were taken already subset from
[Fontsource](https://fontsource.org), which packages the same OFL
originals.
