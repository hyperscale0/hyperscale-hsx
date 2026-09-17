import { BUNDLED_STD_FILES } from "./std-bundle.ts";
export interface StandardLibrary {
  source(header: string): string | undefined;
}
export const bundledStandardLibrary: StandardLibrary = {
  source: (header) => BUNDLED_STD_FILES.get(`${header}.hsx`),
};
