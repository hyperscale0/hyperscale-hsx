/**
 * One program that attaches every standard template with bindings the
 * compiler admits. Each template guide takes its example from here, and
 * std-headers.spec proves the whole program compiles.
 */
export const catalogProgramSource = `program catalog "Template catalog"
use money
use escrow
use purchase
use booking
use marketplace
use financing
use insurance
use lending
use wallet
use cards
use collections
use savings
use reporting
party supplier: business
party inspector: staff role claim_inspector
party investor: business
object item "Item" {
 attach transfer = money.transfer { payer: actor, payee: owner, amount: 750 SAR }
 attach hold = money.hold { payer: actor, payee: owner, amount: 750 SAR }
 attach split = money.split { payer: actor, amount: 750 SAR }
 attach schedule = money.schedule { payer: actor, payee: owner, amount: 750 SAR, count: 3 }
 attach pool = money.pool { payer: actor, payee: owner, target: 1000 SAR, closes: 2027-01-01 }
 attach swap = money.swap { first: actor, second: owner, first_amount: 100 SAR, second_amount: 200 SAR, expires: 2027-01-01 }
 attach payout = money.payout { payer: actor, payee: owner, adapter: "conformance_boundary" }
 attach mandate = money.mandate { payer: actor, payee: owner }
 attach metered = money.metered { payer: actor, payee: owner, unit_price: 10 SAR }
 attach late_fee = money.late_fee { payer: actor, payee: owner, amount: 50 SAR, cap: 500 SAR }
 attach policy = insurance.cover { holder: actor, adapter: "conformance_boundary" }
 attach claim = insurance.claim { cover: policy, inspector: inspector }
 attach cov = insurance.cover { holder: actor, broker: supplier, adapter: "conformance_boundary", covers: sale }
 attach deposit = escrow.hold { payer: actor, payee: owner }
 attach sale = escrow.hold { funding: { controllers: [checkout], reference: "funds", blocking_states: [active] }, payer: actor, payee: owner }
 attach trip = booking.reservation { customer: actor, operator: owner }
 attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
 attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
 attach checkout = purchase.checkout { plans: plan, funds: sale, borrower: actor, capital: operator }
 attach plan = financing.installments { borrower: actor, capital: operator, months: 3, pricing: flat_total, profit_rate: 2.5%, down_payment: 20%, funds: checkout, limits: limits, portfolio: ceiling }
 attach late = financing.late_charge { on: plan, borrower: actor }
 attach line = financing.credit_line { borrower: operator, adapter: "conformance_boundary", limit: 100000 SAR, expires: 2027-01-01 }
 attach advance = financing.advance { line: line }
 attach case = collections.case { on: plan, agency: supplier }
 attach contact = collections.contact { case: case, agency: supplier }
 attach reminder = collections.reminder { on: plan }
 attach wallet = wallet.balance { holder: investor }
 attach spend = wallet.spend { wallet: wallet, payee: supplier, holder: investor }
 attach round = lending.round { borrower: actor, plan: plan, minimum_ticket: 100 SAR, investor_cap: 100% }
 attach commitment = lending.commitment { round: round, wallet: wallet, investor: investor }
 attach distribution = lending.distribution { round: round, receipt: plan.settlement }
 attach cardholder = cards.cardholder { holder: actor }
 attach card = cards.card { holder: cardholder, person: actor, spend_limit: 5000 SAR }
 attach authorization = cards.authorization { card: card, merchant: supplier }
 attach transaction = cards.transaction { authorization: authorization }
 attach dispute = cards.dispute { transaction: transaction }
 attach listing = marketplace.listing { seller: owner }
 attach order = marketplace.order { listing: listing, buyer: actor }
 attach reservation = marketplace.reservation { listing: listing, funds: sale, converters: checkout, buyer: actor, seller: owner }
 attach circle = savings.circle { contribution: 300 SAR, members: 8, starts: 2027-01-01 }
 attach membership = savings.membership { circle: circle, member: actor }
 attach reports = reporting.portfolio { on: plan }
}`;
