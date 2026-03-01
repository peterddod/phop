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
