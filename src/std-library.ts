import { BUNDLED_STD_FILES } from "./std-bundle.ts";

export interface StandardLibrary {
  readonly source: (specifier: string, name: string) => string | undefined;
}

export const bundledStandardLibrary: StandardLibrary = {
  source(specifier: string, name: string): string | undefined {
    if (specifier !== "std/money_flows") return undefined;
    return BUNDLED_STD_FILES.get(`money_flows/${name}.hsx`);
  },
};
