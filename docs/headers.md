# Header inventory

Attach library instruments inside authored object kinds. Each program selects policies through typed tunables.
Bind party parameters to owner, actor, operator or declared parties. Configure declared businesses per Build. The authoringTemplate source is an attach fragment for an object block. An attachment may expose create by name; clock and parent actions remain internal.
`ref<T>[]` accepts one reference or up to 16 references as one policy.

| Instrument | Tunables |
| --- | --- |
| money.transfer | `payer: party`, `payee: party`, `amount: money = runtime` |
| money.hold | `payer: party`, `payee: party`, `amount: money = runtime` |
| money.split | `payer: party`, `amount: money = runtime`, `shares: split = { programOperator: 100% }` |
| money.schedule | `payer: party`, `payee: party`, `amount: money = runtime`, `count: integer(1, 366) = 12` |
| money.pool | `payer: party`, `payee: party`, `target: money`, `closes: date` |
| money.swap | `first: party`, `second: party`, `first_amount: money`, `second_amount: money`, `expires: date` |
| money.payout | `payer: party`, `payee: party`, `adapter: text`, `max_age: duration`, `amount: money = runtime` |
| money.metered | `payer: party`, `payee: party`, `unit_price: money`, `units: integer = 1`, `fee: fee = { seller: 0% }` |
| marketplace.listing | `seller: party` |
| marketplace.order | `listing: ref<marketplace.listing>`, `buyer: party` |
| marketplace.reservation | `listing: ref<marketplace.listing>`, `funds: ref<escrow.hold>`, `plans: ref<financing.installments>[]`, `converters: ref[]`, `buyer: party`, `seller: party`, `expires_after: duration = 48h`, `deposit: money = 1000 SAR`, `cancellation_refund: percent = 100%`, `expiry_refund: percent = 100%`, `retained_to: party = programOperator`, `operator: party = programOperator`, `competing_quotes: enum(allowed, blocked) = allowed` |
| escrow.hold | `payer: party = party(person)`, `payee: party = programOperator`, `accept_within: duration = 48h`, `fee: fee = { seller: 0%, tax: 0% }`, `dispute: policy = { refund_after: return_verified }` |
| wallet.balance | `holder: party`, `spend_limit: money = 100000 SAR` |
| wallet.spend | `wallet: ref<wallet.balance>`, `payee: party` |
| financing.installments | `months: integer(1, 366)`, `charge_limit: integer(1, 3) = 3`, `profit: percent`, `disburse_to: enum(funds, borrower) = funds`, `profit_earned: enum(on_payment, by_schedule, at_disbursement) = on_payment`, `apply: enum(fines_profit_principal, principal_profit, pro_rata) = fines_profit_principal`, `payoff_rebate: percent = 100%`, `write_off_after: duration = 90d`, `max_extension: duration = 90d`, `max_amendments: integer(0, 366) = 2`, `waiver_limit: percent = 100%`, `amendment_expiry: duration = 7d`, `payoff_quote_expiry: duration = 1h`, `allow_overdue: enum(allowed, blocked) = allowed`, `assessed_fines: enum(carry, require_waiver) = carry`, `down_payment: percent = 0%`, `funds: ref<escrow.hold>?`, `borrower: party = party(person)`, `capital: party = programOperator`, `share: percent = 0%`, `limits: ref<financing.limits> = object(financing.limits)`, `portfolio: ref<financing.portfolio_limit> = object(financing.portfolio_limit)` |
| financing.late_charge | `on: ref<financing.installments>[]`, `grace: duration = 3d`, `fine: money = 50 SAR`, `cap: money = 25 SAR`, `fines_to: party = programOperator`, `costs_to: party = programOperator`, `borrower: party = party(person)` |
| financing.limits | `per_borrower: money`, `borrower: party = party(person)`, `active_plans: integer = 1` |
| financing.portfolio_limit | `limit: money` |
| financing.credit_line | `borrower: party = programOperator`, `adapter: text`, `limit: money`, `expires: date` |
| financing.advance | `line: ref<financing.credit_line>`, `amount: money = runtime` |
| lending.round | `borrower: party`, `plan: ref<financing.installments> = object(financing.installments)`, `operator: party = programOperator`, `minimum_ticket: money = 100 SAR`, `investor_cap: percent = 20%`, `commitments: ref<lending.commitment> = object(lending.commitment)` |
| lending.commitment | `round: ref<lending.round>`, `wallet: ref<wallet.balance>`, `investor: party = party(person)` |
| lending.distribution | `round: ref<lending.round>`, `receipt: ref`, `commitments: ref<lending.commitment> = object(lending.commitment)`, `mode: enum(cash, loss) = cash`, `residual_to: party = programOperator`, `operator: party = programOperator`, `fee: percent = 1%`, `tax: percent = 15%` |
| insurance.cover | `holder: party`, `adapter: text`, `commission: percent = 0%`, `covers: ref`, `premium: money = runtime` |
| insurance.claim | `cover: ref<insurance.cover>`, `inspector: party` |
| collections.case | `on: ref<financing.installments>[]`, `agency: party`, `capital: party = programOperator`, `overdue: duration = 3d`, `fee: percent = 20%` |
| collections.contact | `case: ref<collections.case>[]`, `agency: party`, `max_contacts: integer = 10`, `window: duration = 30d`, `contact_from: integer(0, 23) = 8`, `contact_until: integer(1, 23) = 20`, `timezone: text = "Asia/Riyadh"`; contact_from less_than contact_until |
| collections.reminder | `on: ref<financing.installments>[]`, `operator: party = programOperator`, `before_days: integer(0, 366) = 3`, `overdue_days: integer(1, 366) = 1`, `max_per_day: integer(1, 10) = 1`, `send_from: integer(0, 23) = 8`, `send_until: integer(1, 24) = 20`, `timezone: text = "Asia/Riyadh"`; send_from less_than send_until |
| travel.package | `price: money`, `supplier_cost: money`, `departure: date`; supplier_cost at_most price |
| travel.booking | `package: ref<travel.package>`, `buyer: party`, `supplier: party`, `operator: party = programOperator`, `cover: ref<insurance.cover>`, `deposit: percent = 30%`, `balance_before: duration = 14d`, `confirm_within: duration = 24h`, `tax: percent = 15%`, `early_before: duration = 30d`, `middle_before: duration = 15d`, `middle_penalty: percent = 10%`, `late_penalty: percent = 30%`; early_before greater_than middle_before |
| cards.cardholder | `holder: party` |
| cards.card | `holder: ref<cards.cardholder>`, `spend_limit: money` |
| cards.authorization | `card: ref<cards.card>`, `merchant: party`, `issuer: party = programOperator` |
| cards.transaction | `authorization: ref<cards.authorization>` |
| cards.dispute | `transaction: ref<cards.transaction>`, `issuer: party = programOperator`, `within: duration = 90d` |
| savings.circle | `contribution: money`, `members: integer(1, 60)`, `starts: date`, `memberships: ref<savings.membership> = object(savings.membership)` |
| savings.membership | `circle: ref<savings.circle>`, `member: party` |
| reporting.portfolio | `on: ref<financing.installments>[]`, `default_days: integer(1, 3650) = 90`, `retention_years: integer(1, 100) = 10`, `aging_first_days: integer(1, 3650) = 30`, `aging_second_days: integer(1, 3650) = 60`, `aging_third_days: integer(1, 3650) = 90`, `ratio_scale: integer(1, 1000000) = 10000`, `ratio_rounding: enum(floor, halfUp) = floor`, `lock_wait_ms: integer(1, 2000) = 2000`, `capture_ms: integer(1, 10000) = 10000`, `max_rows: integer(1, 100000) = 10000`, `max_join_rows: integer(1, 1000000) = 100000`, `max_bytes: integer(1024, 16777216) = 8388608`; aging_first_days less_than aging_second_days, aging_second_days less_than aging_third_days |
