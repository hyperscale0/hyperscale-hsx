import type { KEYWORDS } from "./lex.ts";

/** Business explanations shared by every HSX editor. */
export const KEYWORD_HELP = {
  program: [
    "Names the financial product and gives it a title.",
    "Product contract",
  ],
  header: ["Names a reusable library of instruments."],
  use: ["Makes a header's instruments available to this program."],
  party: [
    "Declares a person or business that can own accounts or act in an agreement.",
    "Parties",
  ],
  role: ["Names the responsibility a declared party has in this product."],
  currency: ["Sets the currency used by the program's money amounts."],
  instrument: [
    "Defines an agreement's fields, states and permitted actions.",
    "Instruments",
  ],
  fields: ["Declares the values an object or agreement retains.", "Fields"],
  lifecycle: [
    "Lists the agreement's possible states and its starting state.",
    "Lifecycle",
  ],
  action: [
    "Defines an operation that can change an agreement or move money.",
    "Actions",
  ],
  expose: [
    "Makes an attached action available under a public name.",
    "Object action bindings",
  ],
  hide: ["Removes an action from the program's public actions."],
  as: ["Gives an exposed action its public name."],
  cap: ["Limits a percentage charge to a maximum money amount.", "Capped rate"],
  of: [
    "Names the owner of an account, or the records included in a count or sum.",
  ],
  when: ["Includes rules only when a parameter selects the stated option."],
  constraints: [
    "Requires parameter values to agree with each other before the program can be used.",
  ],
  requires: [
    "Rejects an action unless the stated condition holds.",
    "Requirements",
  ],
  invariants: [
    "States conditions that the agreement must preserve.",
    "Invariants",
  ],
  moves: [
    "Declares a transfer, reservation, posting or release of money.",
    "Moves",
  ],
  from: [
    "Names the account money leaves, or the state an action can start from.",
  ],
  to: ["Names the account money reaches, or the state an action enters."],
  in: [
    "Requires a referenced agreement to be in one of the listed states.",
    "State requirement",
  ],
  by: ["Names who performs the stated operation."],
  for: ["Identifies the subject of the stated rule."],
  is: ["Selects rules for one named parameter choice."],
  unique: [
    "Rejects a repeated combination of values in the named namespace.",
    "Unique requirement",
  ],
  on: ["Lists the fields whose combined values must be unique."],
  count: [
    "Limits how many selected records may exist.",
    "Aggregate requirement",
  ],
  sum: [
    "Limits the total value of a field across selected records.",
    "Aggregate requirement",
  ],
  hours: [
    "Allows an action only within the stated local hours.",
    "Hours requirement",
  ],
  between: ["Introduces the opening time of an allowed time window."],
  and: ["Introduces the closing time of an allowed time window."],
  timezone: ["Chooses the timezone used to evaluate allowed hours."],
  evidence: [
    "Requires evidence about the subject with the stated check and result.",
    "Evidence requirement",
  ],
  reserve: [
    "Holds money for later posting or release.",
    "internal_transfer.reserve",
  ],
  post: ["Completes a previously reserved transfer.", "internal_transfer.post"],
  void: [
    "Releases a previously reserved transfer without paying its recipient.",
    "internal_transfer.void",
  ],
  capture: ["Stores the transfer reference for a later posting or release."],
  fee: ["Applies the stated charges to a money movement.", "Move fees"],
  shares: [
    "Divides a money movement among the listed recipients.",
    "Move shares",
  ],
  object: [
    "Declares a business object with fields and attached agreements.",
    "Subjects",
  ],
  attach: [
    "Adds an instrument to an object and binds its parameters.",
    "Subject attachments",
  ],
  subject: [
    "Declares object fields that an action requires before it can run.",
    "Subject requirements",
  ],
  rename: [
    "Changes the names of fields exposed by an attachment.",
    "Attachment field mappings",
  ],
  columns: [
    "Selects the fields shown when listing objects.",
    "Presentation columns",
  ],
} satisfies Record<(typeof KEYWORDS)[number], readonly [string, string?]>;
