# Third-party notices

Shard Atlas's original code and documentation use the [MIT license](LICENSE). Bundled third-party materials retain their own licenses.

## KaTeX

[KaTeX](https://github.com/KaTeX/KaTeX) 0.19.0 supplies offline mathematical rendering. Its JavaScript and CSS are distributed under the [bundled MIT license](static/vendor/katex/LICENSE).

The bundled font software uses the [SIL Open Font License 1.1](static/vendor/katex/fonts/LICENSE). That file includes the embedded copyright notices and reserved font names. See the [upstream font license clarification](https://github.com/KaTeX/KaTeX/issues/339) and [official OFL text](https://openfontlicense.org/documents/OFL.txt).

The original vendored files were verified against the official [`katex@0.19.0` package](https://www.npmjs.com/package/katex/v/0.19.0). Keep both license files when redistributing the interface or desktop bundle.

## Technical references

The C++ release catalog in `static/cpp-releases.json` contains concise authored descriptions and links to public standards papers and references. Source links identify supporting material. Linked websites and standards documents are not bundled with the app and retain their respective rights.

## Spiral timeline companion

The optional Wizard101 inspired timeline ships original SVG landscape illustrations and fallback emblems under this project's MIT license. The public source does not bundle official game artwork, logos, screenshots, or audio. World names identify the inspiration for the memory cues. Wizard101 and its fictional worlds belong to KingsIsle Entertainment. Shard Atlas is an independent project.

Historical descriptions link to supporting announcements. These links do not imply endorsement. See the asset notes in `static/spiral/` for the illustration inventory.

A local installation can use a separately acquired game-icon pack in `static/spiral/local-emblems/`. This entire directory, including its `manifest.json`, is excluded from Git. Locally installed game artwork retains its original rights and is not covered by this project's MIT license. The local server substitutes only existing image files identified by that manifest. Missing or invalid entries retain the original SVG fallback. Local desktop builds include an installed pack, while builds from the public source use the original emblems.

The optional manifest uses `schemaVersion: 1` and an `icons` array. Each icon identifies a catalog emblem by `id`, gives a local raster image `file`, and can include a `sourcePageUrl` for attribution. Keep source and rights information with any locally acquired pack. A download location alone does not establish redistribution permission.
