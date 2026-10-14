import { digest, UDL_FORMAT_VERSION } from "@hyperscale0/udl";
import type { ProviderAdapter } from "@hyperscale0/adl";
import { boundaryAdapters } from "@hyperscale0/adl/boundary-adapters";
import { BUNDLED_STD_HEADERS, HSX_VERSION } from "./std-bundle.ts";

export interface AdapterBindingTarget {
  adapter: ProviderAdapter;
  operation: string;
}

/**
 * Every input a compile reads besides the source, named by one digest. The
 * same source under the same toolchain lowers to the same document anywhere.
 */
export interface Toolchain {
  /** Header source by name, such as `money` for std/money.hsx. */
  readonly std: ReadonlyMap<string, string>;
  /** The boundary bindings a program may name, keyed by binding. */
  readonly adapters: Readonly<Record<string, AdapterBindingTarget>>;
  readonly udl: number;
  readonly hsx: string;
  readonly prover: string;
  readonly digest: string;
}

export function toolchain(input: Omit<Toolchain, "digest">): Toolchain {
  const { std, adapters, udl, hsx, prover } = input;
  return {
    std,
    adapters,
    udl,
    hsx,
    prover,
    digest: digest({
      std: Object.fromEntries(std),
      adapters,
      udl,
      hsx,
      prover,
    }),
  };
}

/** The only toolchain production compiles with. */
export const defaultToolchain = toolchain({
  std: BUNDLED_STD_HEADERS,
  adapters: boundaryAdapters,
  udl: UDL_FORMAT_VERSION,
  hsx: HSX_VERSION,
  prover: `udl-${UDL_FORMAT_VERSION}-laws`,
});
