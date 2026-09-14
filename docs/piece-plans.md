# Compose actions over a piece plan

Use `piece_plan` to declare a finite partition and `piece_stage` to select a
stage of that plan. Use `calls` and `action_library` to share the transfer
body. These are ordinary clauses; they do not add another HSX grammar or a
public operation for each private leaf.

The clause shapes are defined by the selected UDL vocabulary. HSX checks them
in [`typecheck.ts`](../src/typecheck.ts) and preserves them in
[`emit.ts`](../src/emit.ts). The round-trip and private-module examples in
[`general-language.spec.ts`](../test/general-language.spec.ts) exercise this
path. The [UDL output reference](reference/udl-output.md) describes the emitted ABI.

## Worked sale example

This excerpt uses the sale settlement's `price` plan and funding call. It
belongs inside an instrument that declares the referenced immutable fields,
its lifecycle, its partition and its escrow-account capture. It is not a
standalone program. The three money fields partition `price` exactly. For
example, SAR minor-unit amounts `245000`, `3750` and `1250` sum to `250000`.
The separate service fee is outside that partition.

```hsx
piece_plan: {
  id: "price";
  total: "price";
  pieces: [
    { id: "seller"; amount: "piece1Amount";
      release_to: "sellerAccountId"; refund_to: "buyerAccountId"; },
    { id: "platform_fee"; amount: "piece2Amount";
      release_to: "platformAccountId"; refund_to: "buyerAccountId"; },
    { id: "seller_cancel_fee"; amount: "piece3Amount";
      release_to: "platformAccountId"; refund_to: "sellerAccountId"; }
  ];
  fund_order: ["seller", "platform_fee", "seller_cancel_fee"];
  release_order: ["platform_fee", "seller_cancel_fee"];
  refund_order: ["platform_fee", "seller_cancel_fee"];
  unfund_order: ["seller_cancel_fee", "platform_fee", "seller"];
};
action_library: {
  settlement_piece: {
    actionOrder: ["move"];
    actions: {
      move: {
        parameters: {
          piece: { kind: "piece"; };
          source: { kind: "account"; };
          destination: { kind: "account"; };
        };
        principal: "api_key";
        approval: "inherit";
        recovery: "local";
        order: ["transfer"];
        calls: [];
        leaves: [{
          id: "transfer";
          operation: "internal_transfer.create";
          bind: {
            amount: "$piece.amount";
            currency: "$piece.currency";
            sourceAccountId: "$source";
            destinationAccountId: "$destination";
          };
          effects: [{ kind: "moves"; signature: "moves.transfer.internal"; }];
          evidence: "transferId";
        }];
      };
    };
  };
};
action fund_piece {
  public: none;
  piece_stage: { plan: "price"; stage: "fund"; };
  calls: [{
    id: "move_piece";
    action: "settlement_piece.move";
    bind: {
      piece: "$piece";
      source: "$fields.buyerAccountId";
      destination: "$instance.refs.escrowAccountId";
    };
  }];
  steps: [];
  summary: "Fund a piece of a sale settlement";
}
```

The compiler derives `pieceId` from `fund_order`; callers cannot override the
piece amount or destination. The call binds the buyer and captured escrow
account into the one transfer leaf. The stage itself adds no movement.
`public: none` leaves program exposure explicit. Canonical UDL keeps the plan,
library, calls and action order, while resolved plans carry the expanded leaves
and their origin paths. An ordinary exported module value can supply the same
library without publishing another instrument.

For the cancellation path, the same private action binds its destination to
`$piece.refund_to`. `platform_fee` returns to the buyer; `seller_cancel_fee`
pays the seller. Unfund instead binds the buyer for every funded piece, in
reverse order. Handover, cancellation and service-fee collection remain
separate declared actions; a piece plan does not combine their decisions.

## Refusals to understand

UDL diagnostics retain their codes through HSX diagnostic provenance.
[`diagnostics.ts`](../src/diagnostics.ts) owns the HSX mapping, and
[`general-language.spec.ts`](../test/general-language.spec.ts) checks that fatal
UDL codes survive it.

| UDL code  | Meaning for this example                                                              | Repair                                                                    |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `UDL4001` | The money graph loses or creates value on a lifecycle path, including partial funding | Balance the funded amount on every exit and drain held value              |
| `UDL5013` | A stage names an invalid plan/order or lacks the required call form                   | Name `price`, use declared unique piece IDs and declare the stage's calls |
| `UDL2010` | Private calls cycle, name an unresolved action, violate order or exceed bounds        | Keep the graph finite and its order lists exact                           |

The partition itself has `UDL4002` diagnostics for incompatible immutable
fields, amount partition or currency. A stage does not exempt its transfer
from the independent money proof. Calls across different principals,
independent approval or external recovery boundaries are refused; model those
as separate actions. The [diagnostic reference](reference/diagnostics.md) lists the HSX refusal
codes and their repairs.
