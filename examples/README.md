# Examples

Each money flow has its own directory with an HSX program, a
short lesson, and pinned canonical UDL bytes. The test suite reads the module
list from `std/money_flows`, compiles every program, and compares each emitted
document byte for byte.

The numbered examples provide end-to-end walkthroughs:

- [01 · Your first program](01-first-program/README.md)
- [02 · Imports and modules](02-imports-and-archetypes/README.md)
- [03 · Diagnostics](03-diagnostics/README.md)
- [04 · Complete product](04-complete-product/README.md)
- [05 · Watch club](05-watch-club/README.md)

## Money flows

Each money flow has a runnable example directory:

- [advance](advance/README.md)
- [cancellable_booking](cancellable_booking/README.md)
- [captured_payment](captured_payment/README.md)
- [conditional_disbursement](conditional_disbursement/README.md)
- [credit_facility](credit_facility/README.md)
- [held_payment](held_payment/README.md)
- [instant_transfer](instant_transfer/README.md)
- [metered](metered/README.md)
- [pooled_split](pooled_split/README.md)
- [premium_forward](premium_forward/README.md)
- [reconciled_payout](reconciled_payout/README.md)
- [recurring_collection](recurring_collection/README.md)
- [rotating_pool](rotating_pool/README.md)
- [scheduled](scheduled/README.md)
- [security_deposit](security_deposit/README.md)
- [settlement_batch](settlement_batch/README.md)
- [swap](swap/README.md)
- [threshold_pool](threshold_pool/README.md)
- [weighted_distribution](weighted_distribution/README.md)

## Running an example

Run an example with the installed CLI:

```sh
hsx check examples/instant_transfer/instant_transfer.hsx
hsx build examples/instant_transfer/instant_transfer.hsx --out program.udl
```

Every company and person in these files is invented.
