import type { Span } from "./ast.ts";
import type { UdlEffectKind } from "@hyperscale0/udl";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const HSX_TYPE_KINDS = [
  "account",
  "boolean",
  "bps",
  "condition",
  "date",
  "integer",
  "money",
  "party",
  "percent",
  "ref",
  "text",
  "unknown",
] as const;

export interface HsxType {
  readonly currency?: string;
  /** Positive safe integer minor units fixed by money(CUR, amount). */
  readonly fixedAmount?: string;
  readonly kind: (typeof HSX_TYPE_KINDS)[number];
  readonly target?: string;
}

export interface TypedField {
  readonly name: string;
  readonly origin: Span;
  readonly required: boolean;
  readonly schema: Readonly<Record<string, JsonValue>>;
  readonly type: HsxType;
}

export interface TypedAction {
  readonly effects: Readonly<
    Partial<
      Record<
        UdlEffectKind,
        readonly {
          readonly signature: string;
          readonly source: string;
          readonly channel?: string;
          readonly role?: string;
        }[]
      >
    >
  >;
  readonly name: string;
  readonly origin: Span;
  readonly slots: Readonly<Record<string, JsonValue>>;
}

export interface TypedInstrument {
  readonly actions: readonly TypedAction[];
  readonly fields: readonly TypedField[];
  readonly id: string;
  readonly origin: Span;
  readonly slots: Readonly<Record<string, JsonValue>>;
}

export interface TypedSubject {
  readonly declaredValue: "none" | "optional" | "required";
  readonly kind: string;
  readonly origin: Span;
  readonly schema: Readonly<Record<string, JsonValue>>;
  readonly title: string;
  readonly version: number;
}

export interface TypedProgram {
  readonly instruments: readonly TypedInstrument[];
  readonly kind: "typed_program";
  readonly name: string;
  readonly origin: Span;
  readonly subjects: readonly TypedSubject[];
  readonly title: string;
}

export interface GeneralDiagnostic {
  readonly code: string;
  readonly fix: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly span: Span;
}

export interface GeneralCheckResult {
  readonly diagnostics: readonly GeneralDiagnostic[];
  readonly program?: TypedProgram;
}
