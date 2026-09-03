import { BUNDLED_STD_FILES } from "./std-bundle.ts";

export interface StandardLibrary {
  readonly source: (specifier: string, name: string) => string | undefined;
}

export const bundledStandardLibrary: StandardLibrary = {
  source(specifier: string, name: string): string | undefined {
    if (specifier !== "std/settlements") return undefined;
    return BUNDLED_STD_FILES.get(`settlements/${name}.hsx`);
  },
};
