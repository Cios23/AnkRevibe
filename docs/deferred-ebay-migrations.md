# Deferred eBay migrations

Items the bulk publish could not migrate to the Inventory API path.
**Their original listings are live and selling** - verified against eBay,
not just our records - so nothing here is broken or urgent. Deliberately
left alone rather than risking taking revenue offline for consistency.

From the bulk-publish run of 2026-08-26 (362/400 migrated).

## Why each failed

| Reason | Count |
|---|---|
| duplicate-blocked | 20 |
| inventory service input error | 3 |
| missing Card Condition | 2 |
| invalid category id | 1 |

## The duplicate-blocked group

eBay refuses a second live listing for an item it recognises as identical
to one you already have. `scripts/ebay-bulk-publish.mts` publishes the
replacement first and ends the original after, so the two overlap briefly -
tolerated for most items, blocked for these.

Migrating them means ending the legacy listing FIRST, which trades the risk
the other way: if the publish then fails the item is off eBay entirely.
Worth doing one at a time, watching each, using:

```
npm run ebay:live-test -- --inventory-id <uuid> --keep
```

## Items

| Item | Reason |
|---|---|
| 2023 Panini Donruss Elite `b60ea2cd-d811-42a8-8ba5-d4b144ac675c` | missing Card Condition |
| 6 Vintage Plastic Christmas Reindeer Ornaments `06959636-d230-418c-956f-578a12ee0a72` | duplicate-blocked |
| Chicago Blackhawks- NHL Authentic Reebok `1819d951-b4f3-47c9-87a1-4b786744f04c` | inventory service input error |
| Disney Disneyland Resort 1955 Blue Size Kids L `56795dca-84cb-40d9-92f2-07976b8106c3` | duplicate-blocked |
| Disney Rainbow Pride Satin Mickey Mouse Plush `ef7a82c0-de69-4066-a82b-9c8bf1cb1361` | duplicate-blocked |
| Easton Blue & White Baseball Bag `73e3c46f-4aaf-48f3-b5eb-9ade225d3253` | duplicate-blocked |
| Garfield The Movie Plush Cat 9 Inch Goliath An `019ca1f1-e896-48b5-ae99-e9a1b49530a4` | duplicate-blocked |
| Harley Davidson Leather Insulated Winter Glove `31a6b5c1-65fd-477c-956b-4aa5d323dcf5` | invalid category id |
| NWT Men’s Roundhouse Bib Overalls 44x30 Made I `a0820905-76a3-420f-aac0-486ce7cf4808` | inventory service input error |
| OKIDATA LR-190990-10 Print Head `551cb66f-f8b0-4001-a827-f8e84fdc9fb9` | duplicate-blocked |
| Oreo 1995 Unlock the Magic Christmas Collectib `cbd9b8eb-b6db-4363-a022-55c315feef48` | duplicate-blocked |
| Rare Vintage Scooby Doo Plush Holding Hot Dog `acd46a09-676c-43bd-9b26-a02650af796c` | duplicate-blocked |
| Sauce Gardner Purple Prizm 2024 /125 `68fabd9a-7baa-4506-9948-d0ebd23e21ce` | missing Card Condition |
| STARBUCKS 2023 Release Black Pleated Metallic `4bee5453-2fed-4b50-94ab-b5d827f14344` | duplicate-blocked |
| Sylvester Jr.  Plush Animal  The 24K Company V `be0eabaf-e78b-4bb3-bfd4-4e07972a1eca` | duplicate-blocked |
| The North Face Girls M Pink and Gray Denali Po `69023e4f-7e54-4dfb-acb0-654d795d4f50` | duplicate-blocked |
| Vintage Chicago Bears Logo 7 NFL Snapback Hat `f2f949c5-b9aa-46bd-974d-761b1e6c5d60` | duplicate-blocked |
| Vintage Disney The Lion King Simba Face Crossb `2ccddd27-a139-4c9e-a992-d46880e740a9` | duplicate-blocked |
| Vintage Garfield's Odie Dog Plush Toy 1983 Dog `f08e1f95-b3c4-45de-994f-ee1090512386` | duplicate-blocked |
| Vintage Tweety Bird Mittens Warner Bros 1985 R `3c136928-0688-4d0a-919b-ae9164b9a4a5` | duplicate-blocked |
| Vintage Walt Disney World 1970s Crew Neck Swea `aed6196c-f002-4e79-98b2-61e1fe3b1aaa` | duplicate-blocked |
| Vtg 1991 Treasure Troll 12” Doll Blue Eyes Pur `f7d3aa35-b686-4db3-91b7-5a6b0015bf79` | inventory service input error |
| Vtg Matrix Trimming the Tree Animated Musical `3b015339-22a0-403b-8b47-f15422114770` | duplicate-blocked |
| Walt Disney Winnie The Pooh And Piglet Piggy B `ad9c185b-f9f6-4c0f-8e8c-4f73e7a3eaa7` | duplicate-blocked |
| WALT DISNEY WORLD GLASS Remember  Fantasia Mic `af384f39-daef-49ea-b96d-a19dbcafe710` | duplicate-blocked |
| WWE `ff6aea19-2354-42e4-bbe7-374ab3325cf1` | duplicate-blocked |

## Also deferred: 12 items with no condition data

Skipped by the bulk script rather than guessed at - a wrong condition is a
false claim on a live listing. Fill in `condition` and re-run
`npm run ebay:bulk-publish -- --end-legacy` to pick them up.

