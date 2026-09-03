export const stdSettlementModules = [
  "advance",
  "cancellable_booking",
  "captured_payment",
  "conditional_disbursement",
  "credit_facility",
  "reconciled_payout",
  "security_deposit",
  "threshold_pool",
  "held_payment",
  "instant_transfer",
  "metered",
  "pooled_split",
  "premium_forward",
  "recurring_collection",
  "rotating_pool",
  "scheduled",
  "settlement_batch",
  "swap",
  "weighted_distribution",
] as const;

export type StdSettlementModule = (typeof stdSettlementModules)[number];

interface ArchetypeWitnessCase {
  readonly modules: readonly StdSettlementModule[];
}

export const archetypeWitnessCases = {
  "examples/01-first-program/tip-jar.hsx": {
    modules: ["instant_transfer"],
  },
  "examples/02-imports-and-archetypes/photo-booth.hsx": {
    modules: ["held_payment"],
  },
  "examples/03-diagnostics/corner-shop-fixed.hsx": {
    modules: ["held_payment"],
  },
  "examples/04-complete-product/study-hall.hsx": {
    modules: ["held_payment", "security_deposit", "pooled_split"],
  },
  "examples/05-watch-club/watch-club.hsx": {
    modules: [
      "instant_transfer",
      "security_deposit",
      "scheduled",
      "recurring_collection",
      "swap",
      "settlement_batch",
    ],
  },
  "test/fixtures/captured-payment.hsx": {
    modules: ["captured_payment"],
  },
  "test/fixtures/car-escrow.hsx": { modules: ["held_payment"] },
  "test/fixtures/comic-swap.hsx": { modules: ["swap"] },
  "test/fixtures/commerce-escrow.hsx": {
    modules: ["instant_transfer", "security_deposit", "pooled_split"],
  },
  "test/fixtures/credit-facility.hsx": {
    modules: ["scheduled", "credit_facility"],
  },
  "test/fixtures/decided-deposit.hsx": {
    modules: ["security_deposit"],
  },
  "test/fixtures/derived-amount.hsx": {
    modules: ["instant_transfer"],
  },
  "test/fixtures/financed-retention.hsx": {
    modules: ["held_payment", "advance", "scheduled"],
  },
  "test/fixtures/funding-round.hsx": {
    modules: ["threshold_pool"],
  },
  "test/fixtures/delegated-rotating-pool.hsx": {
    modules: ["rotating_pool"],
  },
  "test/fixtures/expiring-security-deposit.hsx": {
    modules: ["security_deposit"],
  },
  "test/fixtures/fixed-side-swap.hsx": {
    modules: ["swap"],
  },
  "test/fixtures/flat-weighted-distribution.hsx": {
    modules: ["weighted_distribution"],
  },
  "test/fixtures/grammar-coverage.hsx": {
    modules: ["held_payment", "scheduled"],
  },
  "test/fixtures/installment-obligation.hsx": {
    modules: ["scheduled"],
  },
  "test/fixtures/insured-car-marketplace.hsx": {
    modules: ["held_payment", "premium_forward", "security_deposit"],
  },
  "test/fixtures/insured-travel.hsx": {
    modules: ["scheduled", "metered", "advance"],
  },
  "test/fixtures/open-membership.hsx": {
    modules: ["scheduled", "recurring_collection"],
  },
  "test/fixtures/policy-disbursement.hsx": {
    modules: ["premium_forward", "conditional_disbursement"],
  },
  "test/fixtures/recurring-collection.hsx": {
    modules: ["scheduled", "recurring_collection"],
  },
  "test/fixtures/retention-holdback.hsx": {
    modules: ["held_payment"],
  },
  "test/fixtures/rotating-pool.hsx": {
    modules: ["rotating_pool"],
  },
  "test/fixtures/referenced-threshold-pool.hsx": {
    modules: ["threshold_pool"],
  },
  "test/fixtures/settlement-batch.hsx": {
    modules: ["settlement_batch"],
  },
  "test/fixtures/cancellable-booking.hsx": {
    modules: ["cancellable_booking"],
  },
  "test/fixtures/reconciled-payout.hsx": {
    modules: ["reconciled_payout"],
  },
  "test/fixtures/unified-fees.hsx": {
    modules: ["instant_transfer"],
  },
  "test/fixtures/whole-held-payment.hsx": {
    modules: ["held_payment"],
  },
  "test/fixtures/weighted-distribution.hsx": {
    modules: ["weighted_distribution"],
  },
} as const satisfies Record<string, ArchetypeWitnessCase>;
