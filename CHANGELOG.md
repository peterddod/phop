# [1.6.0](https://github.com/peterddod/phop/compare/v1.5.0...v1.6.0) (2026-09-27)


### Bug Fixes

* **ci:** publish to npm with trusted publishing ([c099266](https://github.com/peterddod/phop/commit/c09926677225025e867631bd859dd9de4e818d4f))


### Features

* **phop:** add isRunning option and version counter to hosted simulation ([97ce304](https://github.com/peterddod/phop/commit/97ce304f4b15a58e2f809f8cae147a210d32828e))

# [1.5.0](https://github.com/peterddod/phop/compare/v1.4.1...v1.5.0) (2026-09-27)


### Bug Fixes

* **build:** repair root and example build scripts ([8dd3b7e](https://github.com/peterddod/phop/commit/8dd3b7eec45d74e65511bb3a72a157707d4c6b6d))
* **phop:** harden handover, lobby trust and disconnect handling ([51fbcfb](https://github.com/peterddod/phop/commit/51fbcfb93e4976aad087607491ac7ef9d3afc61e))


### Features

* **phop:** add host-authoritative networking primitives ([c1a7f99](https://github.com/peterddod/phop/commit/c1a7f994ea3257c7acca433f2c0e5a0b1f7566a9))

## [1.4.1](https://github.com/peterddod/phop/compare/v1.4.0...v1.4.1) (2026-03-26)


### Bug Fixes

* **ci:** publish from semantic-release tag ([0d4122e](https://github.com/peterddod/phop/commit/0d4122e56f35217e80f41803dbb27f16bd6f52f3))

# [1.4.0](https://github.com/peterddod/phop/compare/v1.3.0...v1.4.0) (2026-03-26)


### Bug Fixes

* **example:** use functional updaters in counter controls ([78b29c8](https://github.com/peterddod/phop/commit/78b29c89b1980e36f39408c16bfd6fff79d9876b))
* memoize peer query params and align peerId test setup ([05c3c01](https://github.com/peterddod/phop/commit/05c3c0168ca3a248218c63aeec921250036a1cb4))
* **phop:** address review nits for docs, accessibility, and test helpers ([22229f6](https://github.com/peterddod/phop/commit/22229f6076f3fc4737c43db5fc690c5eaea494de))
* **phop:** keep shared-state hooks render-pure and selector-aware ([e197bcf](https://github.com/peterddod/phop/commit/e197bcfd5d57cc9f036d26a4299e006faa7fb748))
* **phop:** satisfy hook rules and exhaustive deps in shared state ([46b206c](https://github.com/peterddod/phop/commit/46b206c52f219f3aaa22a94a23ed641685e5592e))


### Features

* **example:** showcase shared store label and isolate demo rooms ([34d4b92](https://github.com/peterddod/phop/commit/34d4b9233b4e06b1621f009a3b316851688bbac8))
* **phop:** add shared store API with synced controller core ([07ad0c0](https://github.com/peterddod/phop/commit/07ad0c047d4282df37397210c5008719ecc38acb))

# [1.3.0](https://github.com/peterddod/phop/compare/v1.2.0...v1.3.0) (2026-03-01)


### Bug Fixes

* **consensus:** canonicalise arrays in sortKeys and validate maxRetries ([de06ad1](https://github.com/peterddod/phop/commit/de06ad1fcc9c5493d5f062ccc2247a9d48bccab1))
* **consensus:** enforce round membership and monotonic index guards ([1d8f89d](https://github.com/peterddod/phop/commit/1d8f89dcf7ee3c96108825e921e9ce9c8f29ad30))
* **consensus:** fix double-encoding in deterministic hash ([04b0f71](https://github.com/peterddod/phop/commit/04b0f7194b8b4a516b8e03df0fb65a360028fda4))
* **consensus:** handle peer departures mid-round, cap retries, clarify pendingWrite semantics ([48db7fe](https://github.com/peterddod/phop/commit/48db7fe7910b9a1a2cba213c36edfa5eafcd8602))
* **consensus:** preserve local proposal when all remote peers depart mid-round ([30eec91](https://github.com/peterddod/phop/commit/30eec91ffdfb697a28c13bf6f5f1327a7c20a4d3))
* **consensus:** resolve protocol stalls and correct merge priority ([54cda30](https://github.com/peterddod/phop/commit/54cda3024a9458439081c738280b3397ad0cb82c))
* **consensus:** seed roundIndex from committed meta and advance after StatePush ([34dfc69](https://github.com/peterddod/phop/commit/34dfc69beb2008178e8d5aea5f3604ea9dbaaff6))
* **phop:** monotonic LWW timestamps, safe peer-change dispatch, and guarded broadcast payloads ([b80de63](https://github.com/peterddod/phop/commit/b80de6314b170bba908d0e819ea7c57a53bcf545))
* **phop:** strengthen isSharedStatePayload type guard ([ddc17f3](https://github.com/peterddod/phop/commit/ddc17f35cade8faccf15bfa7a992789e35d67877))


### Features

* **phop:** add consensus merge strategy ([94022da](https://github.com/peterddod/phop/commit/94022dacc2366c5895d3b23ccd27856505cb081c))

# [1.2.0](https://github.com/peterddod/phop/compare/v1.1.16...v1.2.0) (2026-03-01)


### Features

* **integration-tests:** add Playwright integration test suite ([4093af8](https://github.com/peterddod/phop/commit/4093af8b91214e56fa88821de3db37f4bf5980d6)), closes [hi#level](https://github.com/hi/issues/level)

## [1.1.16](https://github.com/peterddod/phop/compare/v1.1.15...v1.1.16) (2026-03-01)


### Bug Fixes

* **ci:** switch npm publish auth to NPM_TOKEN instead of trusted publisher ([8dbeb6d](https://github.com/peterddod/phop/commit/8dbeb6d114236529792b88dc28547f55dca161e3))

## [1.1.15](https://github.com/peterddod/phop/compare/v1.1.14...v1.1.15) (2026-03-01)


### Bug Fixes

* **ci:** pin Node to 22.14.0 for trusted publisher npm CLI requirement ([576fca9](https://github.com/peterddod/phop/commit/576fca9a4040fcf3b15f01208d5ab44db542622f))

## [1.1.14](https://github.com/peterddod/phop/compare/v1.1.13...v1.1.14) (2026-03-01)


### Bug Fixes

* **ci:** use Node 22 for Trusted Publisher OIDC requirement, drop token and --provenance flag ([8e2a571](https://github.com/peterddod/phop/commit/8e2a5710c7e7c1567a27da79262c4592a9876844))

## [1.1.13](https://github.com/peterddod/phop/compare/v1.1.12...v1.1.13) (2026-03-01)


### Bug Fixes

* **ci:** restore registry-url and use NPM_TOKEN for npm publish auth ([bb7a813](https://github.com/peterddod/phop/commit/bb7a813f9d5490de11b3fbbc0df65d258d215251))

## [1.1.12](https://github.com/peterddod/phop/compare/v1.1.11...v1.1.12) (2026-03-01)


### Bug Fixes

* **ci:** remove registry-url from setup-node to allow Trusted Publisher OIDC auth ([c607da6](https://github.com/peterddod/phop/commit/c607da605493dce1f93e004fec500d79312e713f))

## [1.1.11](https://github.com/peterddod/phop/compare/v1.1.10...v1.1.11) (2026-03-01)


### Bug Fixes

* **ci:** add --provenance flag to npm publish for Trusted Publisher OIDC ([aa21d8a](https://github.com/peterddod/phop/commit/aa21d8ac3c32bd888d31572fae6cebd21322d416))

## [1.1.10](https://github.com/peterddod/phop/compare/v1.1.9...v1.1.10) (2026-03-01)


### Bug Fixes

* **ci:** run semantic-release before builds so version is bumped first ([8eee5e1](https://github.com/peterddod/phop/commit/8eee5e184524d90d4e0d3acc7f650e842169c904))

## [1.1.9](https://github.com/peterddod/phop/compare/v1.1.8...v1.1.9) (2026-03-01)


### Bug Fixes

* **release:** replace manual git push with @semantic-release/git plugin ([10aea19](https://github.com/peterddod/phop/commit/10aea19c19b1cb41cac1a40b808de6c294844efa))

# 1.0.0 (2026-02-24)


### Bug Fixes

* address review feedback on docs and Dockerfile ([29c4ef6](https://github.com/peterddod/phop/commit/29c4ef6dbcc251ed8c8f4539558a6bd9251e211c))
* addressed errors in signalling server ([775366e](https://github.com/peterddod/phop/commit/775366e19e4ee7cd67a477fb0faf210b5b34410b))
* **config:** use auto_incremental_review in CodeRabbit schema ([6a2cbb3](https://github.com/peterddod/phop/commit/6a2cbb31a4d033493e391db8b49d4ba32991572b))
* correct bun workspace scripts and autostart signalling server in dev ([ca67df5](https://github.com/peterddod/phop/commit/ca67df54c82185bffa79fc8d86ae7f678e28c9e8))
* downgrade semantic-release to v24 for bun compatibility ([4aeedca](https://github.com/peterddod/phop/commit/4aeedca399e049bbc56a39fcc28b0f3e5683e4b5))
* improved scripts in repo root ([a93c0b5](https://github.com/peterddod/phop/commit/a93c0b55a6663458f4953fbf919e7a3c8e7611bf))
* linting ([24daae8](https://github.com/peterddod/phop/commit/24daae8598f24fb50636756dddea63585fd6e6b6))
* package.json scripts work ([8e6aa78](https://github.com/peterddod/phop/commit/8e6aa78b4b39bdfc6ee688b3c841cc4e0f125b27))
* replace @semantic-release/npm with exec to avoid workspace: protocol error ([b010e4c](https://github.com/peterddod/phop/commit/b010e4ca30f39a559587c175c0855c1d4f9db9f3))
* resolve biome lint errors ([567ffe2](https://github.com/peterddod/phop/commit/567ffe273965de0b8ca3e3da54f5251f1f83af65))
* **Room:** adopt PeerConnection options object and align broadcast/sendToPeer types ([0e6c48a](https://github.com/peterddod/phop/commit/0e6c48aebd397ea5f3c233d6374e01eb00e4e33d))
* switch Dockerfile to Bun and fix signalling spelling ([0ace540](https://github.com/peterddod/phop/commit/0ace54095976519f28270c3e5ae2e6cdbc7992bd))
* **useSharedState:** normalize empty tiebreaker in accepted Lamport meta ([bb91f3a](https://github.com/peterddod/phop/commit/bb91f3add23db861e70a577258ac26d36929c293))
* **useSharedState:** reset rawStateMetaRef when strategy changes ([21ac7d1](https://github.com/peterddod/phop/commit/21ac7d17bb7d79117447bc227c46ec04037cbfd5))
* **useSharedState:** resolve indeterminate tiebreak when both peers have empty initialMeta ([ad9fe7c](https://github.com/peterddod/phop/commit/ad9fe7c33f2c916bd57dfdb046a1fd8a92563dc1))
* **useSharedState:** stabilise strategy effect dep and add type-safe overloads ([339f662](https://github.com/peterddod/phop/commit/339f6628549432e392f0c99daa70c9fa9e30f693))
* **useSharedState:** sync state on data channel open instead of peer list change ([7c07f03](https://github.com/peterddod/phop/commit/7c07f0363827b42484c08e7741f391815eab8ce7))


### Features

* added signalling client class for websocker connection ([eff4c34](https://github.com/peterddod/phop/commit/eff4c34653788b7f7cbcbdfdf183fb04bc501461))
* **ci:** add automated versioning and releases ([1888b16](https://github.com/peterddod/phop/commit/1888b167275e9bc3b76f2f6f513150bfa3318a37))
* **example:** rewrite demo as shared counter with relay server input ([794d820](https://github.com/peterddod/phop/commit/794d82026fd2856f7032f8375d85de7c45bf40e3))
* implemented room context ([25305e4](https://github.com/peterddod/phop/commit/25305e47e963d37f7ec88e4614da0be425b4a5f2))
* peer connection class ([0dc0e8a](https://github.com/peterddod/phop/commit/0dc0e8a1fb1550424cf1d9e27c0ed05f9a390a4e))
* **react-p2p:** add keyed shared state with per-key subscriptions ([8f313de](https://github.com/peterddod/phop/commit/8f313ded2c468659437ab707ab34ec9a0e4dc85c))
* setup react p2p scaffolding ([f8c757d](https://github.com/peterddod/phop/commit/f8c757d2129e8be77370f67011833a81f79f1e4b))
* setup working example ([6146457](https://github.com/peterddod/phop/commit/6146457ac5026c6eb711f89bc3d6d996b90c86bc))
* signalling server matches signalling client class ([bcbc8c6](https://github.com/peterddod/phop/commit/bcbc8c6a5deeb7ca421d107320c41f748932acc8))
* **useSharedState:** add late joiner sync and pluggable merge strategy ([a330f47](https://github.com/peterddod/phop/commit/a330f47bda9cc53362972f3b409cc5f048cfb5bf))
* **useSharedState:** replace wall-clock default with Lamport logical clock ([c511718](https://github.com/peterddod/phop/commit/c51171856eeca7c89726f31e955d3f9113aa8563))
