# Hyperscale Intellectual Property and Copyright License

Version 1.0, effective 18 September 2026. This text is under review by
Hyperscale LLC's counsel. Until a revised version replaces it, it states the
terms on which Hyperscale makes the Software available.

SPDX identifier: `LicenseRef-Hyperscale-IPCL-1.0`

Copyright (c) 2026 Hyperscale LLC. All rights reserved.

This is not an open source license. The Software is proprietary. Hyperscale
publishes some of it so that you can read it, learn it, build on the Hyperscale
platform with it, and verify what Hyperscale runs. Publishing is not a gift of
rights. Every right not written in this License stays with Hyperscale.

---

## 1. Acceptance

By accessing, viewing, downloading, cloning, installing, copying, compiling,
running, or otherwise using any part of the Software, you accept this License.
If you do not accept it, do none of those things. If you act for an
organisation, you confirm you have authority to bind it, and "you" means that
organisation and every person acting for it.

## 2. Definitions

"Hyperscale" means Hyperscale LLC, a limited liability company organised under
the laws of the Kingdom of Saudi Arabia, and its successors and assigns.

"Software" means every work Hyperscale distributes under this License, in any
form: source code, compiled or bundled code, schemas, grammars, standard
libraries, headers, example programs, fixtures, conformance cases, generated
artifacts, documentation, designs, images, and data files, and every update,
version, or part of any of them.

"Specification" means the parts of the Software that Hyperscale designates as a
Specification in the applicable Notice: a schema, grammar, wire format,
manifest format, vocabulary, or interface description, together with its
documentation and published example inputs and outputs.

"Hyperscale Platform" means the products and services Hyperscale offers or
operates, in any form and under any name, including Hyperscale Arc, Architect,
Composer, the Hyperscale engine, portals, registries, hosted compilers, hosted
MCP servers, generated SDKs, and every successor product.

"Notice" means the file named `NOTICE` or `NOTICE.md`, or the license
statement in a package manifest, that accompanies a copy of the Software and
states which Tier under section 4 applies to it.

"Tier" means one of the three permission levels in section 4.

"Derivative Work" means any work that is based on, incorporates, translates,
adapts, ports, reimplements, transforms, or is derived from the Software or any
part of it, in any language or form, including a work produced by studying the
Software and then writing new code that performs the same function.

"Competing Product" means any product, service, library, platform, or tool,
whether or not sold, that performs or is offered as performing substantially the
same function as the Hyperscale Platform or any part of it, including: a
language, compiler, or checker for financial programs; an engine, runtime, or
ledger that executes financial product definitions; a framework for declaring,
conforming, or operating bank or payment provider adapters; a service that
generates APIs, SDKs, or agent tools from a financial product definition; or a
hosted or embedded version of any of those. A product you build on the
Hyperscale Platform for your own customers is not a Competing Product.

"Hosted Use" means making the functionality of the Software available to any
third party over a network, whether as a service, an API, an agent tool, an
embedded feature, or otherwise.

"Contribution" means any work of authorship you intentionally submit to
Hyperscale for inclusion in the Software, by any means, unless you clearly mark
it "not a contribution".

"Marks" means the names, logos, and trade dress of Hyperscale and its products,
including "Hyperscale", "Hyperscale Arc", "HSX", "UDL", "ADL", "Architect",
"Composer", the `hyperscale0` GitHub organisation, the `@hyperscale0` npm
scope, and every confusingly similar name or sign.

"Confidential Material" means Software distributed under Tier 3, and any part
of the Software that Hyperscale has not made publicly available.

## 3. Ownership

Hyperscale owns all right, title, and interest in the Software, the
Specifications, the Marks, and every Derivative Work Hyperscale creates,
including all copyright, patent, trade secret, design, database, and moral
rights, worldwide. The Software is licensed, not sold. This License transfers
no ownership of anything to you. Your possession of a copy, in any form, gives
you no right in it beyond what this License states.

The Specifications describe how the Hyperscale Platform works. The design
choices they record, the vocabulary they fix, the structure of the financial
programs, products, ledgers, and adapters they define, and the standard library
of financial instruments Hyperscale publishes are Hyperscale's intellectual
property. Publication does not place any of it in the public domain.

## 4. Tiers of permission

Every copy of the Software carries a Notice naming its Tier. If a copy carries
no Notice, Tier 3 applies. A permission granted at a higher-numbered Tier is
never implied at a lower-numbered one.

### Tier 1: Open Specification

For Software designated as a Specification, Hyperscale grants you a worldwide,
non-exclusive, non-transferable, royalty-free, revocable license to:

1. read, copy, and redistribute the Specification, unmodified and with all
   notices intact;
2. write programs, documents, and data that conform to the Specification, and
   use them in any way, including commercially;
3. write and distribute software that reads, writes, validates, or displays
   data conforming to the Specification, solely for the purpose of using or
   interoperating with the Hyperscale Platform or with products built on it;
4. quote reasonable portions of the Specification in documentation, teaching,
   and commentary, with attribution to Hyperscale.

Tier 1 does not permit you to build a Competing Product, to publish a modified
Specification under any name that includes or resembles a Mark, or to claim
conformance or compatibility except as section 8 allows.

### Tier 2: Source Available

For Software designated as Source Available, Hyperscale grants you a worldwide,
non-exclusive, non-transferable, non-sublicensable, royalty-free, revocable
license to:

1. view, download, and study the source;
2. install, compile, and run the Software, unmodified or modified, on systems
   you control, for the purpose of building, testing, operating, and
   maintaining your own products on the Hyperscale Platform;
3. modify the Software for that purpose and keep the modification for your own
   internal use;
4. submit modifications to Hyperscale as Contributions;
5. redistribute unmodified copies of the Software, in the form Hyperscale
   published them, with all notices and this License intact, for example by
   mirroring a package or vendoring a dependency.

Tier 2 does not permit Hosted Use, distribution of modified copies,
distribution of compiled or bundled forms other than those Hyperscale
published, or any use in or toward a Competing Product.

### Tier 3: Confidential

For Software designated as Confidential, or carrying no Notice, Hyperscale
grants you only the license written in the agreement under which you received
it. If there is no such agreement, you have no license, and you must not use,
copy, disclose, or retain the Software. Confidential Material includes generated
SDKs, downloadable product artifacts, private repositories, and anything you
obtain through a portal, a registry, or a signed-in session. You may use
Confidential Material only for your own organisation's Hyperscale integration,
must not publish it to any public repository or package registry, must not
disclose it beyond personnel and contractors who need it and are bound by
confidentiality at least as protective as this License, and must destroy it on
request or when your access ends.

## 5. Restrictions

Whatever the Tier, you must not, and must not help or allow anyone else to:

1. build, contribute to, market, sell, or operate a Competing Product using
   the Software, a Derivative Work, or knowledge gained from the Software;
2. create a Derivative Work except as Tier 2 permits for internal use;
3. reimplement, port, translate, or clone the Software or any part of it, in
   any programming language, whether by copying or by studying it and
   rewriting it;
4. offer the Software or a Derivative Work for Hosted Use;
5. sublicense, sell, rent, lease, lend, or assign the Software or any right in
   it;
6. remove, hide, or alter any copyright, trademark, license, or attribution
   notice, or misstate the origin of the Software;
7. reverse engineer, decompile, disassemble, or unminify any compiled, bundled,
   or generated form of the Software, except where a law forbids this
   restriction and only to the extent it does;
8. circumvent, disable, or evade any license check, access control, rate limit,
   key, or technical protection in the Software or the Hyperscale Platform;
9. use the Software, the Specifications, or any output of the Hyperscale
   Platform as training, fine-tuning, evaluation, or retrieval data for any
   machine-learning model, or to generate a Competing Product with such a
   model, without Hyperscale's prior written consent;
10. use the Software to benchmark or compare the Hyperscale Platform in any
    publication without Hyperscale's prior written consent;
11. register, apply for, or claim any patent, trademark, design, or domain
    name that covers or resembles the Software, the Specifications, or the
    Marks;
12. use the Software in violation of any law, sanction, or export control;
13. use the Software for any purpose this License does not expressly permit.

## 6. Contributions

You are not required to contribute. If you do, then on submission you grant
Hyperscale, and everyone who receives the Software from Hyperscale, a
perpetual, worldwide, non-exclusive, irrevocable, royalty-free license to use,
reproduce, modify, distribute, sublicense, and relicense your Contribution
under any terms, including this License and any commercial license, and you
grant Hyperscale a patent license of the same scope covering the claims your
Contribution alone or in combination with the Software would infringe. You
confirm you have the right to make these grants and that the Contribution is
your own work or that you have permission to submit it. Hyperscale may require
a signed contributor agreement before merging any Contribution and may decline
any Contribution for any reason. Feedback, suggestions, and ideas you send
about the Software are not confidential and Hyperscale may use them freely.

## 7. Marks

This License grants no right to any Mark. You may refer to the Software and to
the Hyperscale Platform by name to describe truthfully that your product uses
or integrates with them. You must not use any Mark as or in the name of your
product, company, package, domain, or repository, in a logo, or in any way that
suggests Hyperscale made, sponsors, certifies, or endorses your work.

## 8. Conformance and compatibility claims

You may state that your product "conforms to" or "is compatible with" a named
Specification version only if, at the time of the claim, your product
validates against the Specification exactly as Hyperscale published it, using
Hyperscale's published example inputs unmodified, and you built the product
under Tier 1 for the purpose of interoperating with the Hyperscale Platform.
The claim is a statement about your product and never an endorsement by
Hyperscale. Hyperscale may require you to withdraw a claim it considers false.
No claim of conformance permits a Competing Product.

## 9. Commercial license

Hyperscale offers a commercial license to organisations whose use falls
outside this License, including Hosted Use, distribution of modified copies,
embedding in a proprietary product, or any use a procurement policy cannot
accept under these terms. Ask through <https://hyperscale0.ai>. Nothing in this
section grants any right until a commercial agreement is signed.

## 10. Prior releases

Any version of the Software that Hyperscale released under a different license
remains available under that license for that version only. This License
applies to every version that carries it and to every later version unless
that version states otherwise. Nothing in this License narrows a right you
already hold in a prior version under its own license.

## 11. Term and termination

This License takes effect when you accept it and lasts until terminated. It
terminates automatically, with no notice, the moment you breach section 5 or
section 7. For any other breach, it terminates thirty days after Hyperscale
notifies you, unless you cure the breach within that period and it is the
first notice you have received. Hyperscale may also terminate this License for
convenience for any Tier 3 material, on notice. On termination you must stop
all use, destroy every copy in your possession or control, including
Derivative Works, and confirm destruction in writing if asked. Sections 3, 5,
6, 7, 11, 12, 13, 14, 15, and 16 survive termination.

## 12. Disclaimer of warranty

The Software is provided "as is" and "as available". Hyperscale makes no
warranty of any kind, express, implied, or statutory, including any warranty
of merchantability, fitness for a particular purpose, title, non-infringement,
accuracy, or that the Software will be error-free or uninterrupted. Hyperscale
is not a bank, does not hold money, and gives no assurance that any financial
program, product, or adapter written with the Software is lawful, licensed,
or fit for any real-world financial use in any jurisdiction.

## 13. Limitation of liability

To the fullest extent the law allows, Hyperscale is not liable to you or any
third party for any indirect, incidental, special, consequential, exemplary, or
punitive damages, or for any loss of profit, revenue, data, goodwill, or
business opportunity, arising from or related to the Software or this
License, however caused and under any theory of liability, even if advised of
the possibility. Hyperscale's total liability under this License is limited to
one thousand Saudi riyals (SAR 1,000) or the amount you paid Hyperscale for the
Software in the twelve months before the claim, whichever is greater.

## 14. Indemnity

You will defend, indemnify, and hold harmless Hyperscale, its owners,
officers, employees, and agents from every claim, loss, damage, liability,
cost, and expense, including reasonable legal fees, arising from your use of
the Software, your Derivative Works, your products, or your breach of this
License.

## 15. Remedies and enforcement

You acknowledge that the Software embodies valuable trade secrets and
intellectual property of Hyperscale, that a breach of section 3, 4, 5, or 7
would cause Hyperscale irreparable harm that money alone cannot repair, and
that Hyperscale is entitled to injunctive and other equitable relief in any
court of competent jurisdiction to stop or prevent a breach, without posting a
bond and in addition to every other remedy. You will pay Hyperscale's
reasonable legal fees and costs in any action in which Hyperscale enforces
this License and prevails on any claim. Hyperscale may bring an action in the
courts named in section 16 or in any jurisdiction where the Software is used,
a Derivative Work is made, or a Competing Product is offered, and you consent
to the jurisdiction of those courts.

## 16. Governing law and venue

This License is governed by the laws of the Kingdom of Saudi Arabia, including
the Copyright Law issued by Royal Decree M/41 and its implementing
regulations, without regard to conflict-of-law rules. The competent courts of
Riyadh have exclusive jurisdiction over any dispute arising from this License,
subject to Hyperscale's right under section 15 to enforce elsewhere. The
Berne Convention and the TRIPS Agreement apply to the protection of the
Software in every member state. Where a law of another jurisdiction gives you
a right this License cannot exclude, that right is preserved to the minimum
extent that law requires and no further.

## 17. General

1. This License is the entire agreement between you and Hyperscale about the
   Software under its Tier, and replaces every earlier or contemporaneous
   understanding, except a signed commercial agreement, which prevails where
   the two conflict.
2. If any provision is held unenforceable, it is limited to the minimum
   extent necessary and the rest stays in force.
3. Hyperscale's failure or delay in enforcing any provision is not a waiver.
   A waiver is effective only in writing signed by Hyperscale.
4. You may not assign or transfer this License or any right under it, by
   operation of law or otherwise, and any attempt is void. Hyperscale may
   assign it freely.
5. Hyperscale may publish new versions of this License. Each version of the
   Software carries the License version it was released under, and a new
   License version applies only to Software that carries it.
6. This License is written in English. Hyperscale may publish an Arabic
   translation. Where a court requires an Arabic text, the certified Arabic
   translation Hyperscale provides is the text of record; in every other case
   the English text governs.
7. Nothing in this License creates a partnership, joint venture, agency, or
   employment relationship between you and Hyperscale.
8. Notices to Hyperscale go to the address published at
   <https://hyperscale0.ai/legal>.

---

## Applying this License

A copy of the Software must carry this file as `LICENSE.md` and a `NOTICE.md`
that states the Tier. The form is:

```
This work is licensed under the Hyperscale Intellectual Property and
Copyright License, version 1.0 (LicenseRef-Hyperscale-IPCL-1.0).
Copyright (c) 2026 Hyperscale LLC. All rights reserved.

Tier: 2 (Source Available)
Specifications under Tier 1 in this repository: spec/, docs/grammar.md

Not open source. See LICENSE.md.
```

A package manifest states `"license": "SEE LICENSE IN LICENSE.md"`. A source
file may carry the one-line header:

```
// Copyright (c) 2026 Hyperscale LLC. Licensed under LicenseRef-Hyperscale-IPCL-1.0. Not open source.
```
