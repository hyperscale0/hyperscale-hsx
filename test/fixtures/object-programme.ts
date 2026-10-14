import { subjectAdapter } from "../../../adl/conformance/subject-adapter.ts";
import { testToolchain } from "./toolchain.ts";

export const carsSource = `program cars "Cars"
object car "Cars" {
  fields { make: text, model: text, year: integer }
  columns: [make, model, year]
  attach verification = subject_fixture.verification {
    expose check as check
  }
}`;

export const subjectHeader = `header subject_fixture
instrument verification {
  summary: "Synthetic adapter conformance check"
  fields {}
  lifecycle { states: [pending, checked], initial: pending }
  action create {}
  action check {
    summary: "Check reference"
    from: pending, to: checked
    subject { adapter: verification }
  }
}`;

export const objectProgrammeToolchain = testToolchain([subjectHeader], {
  verification: { adapter: subjectAdapter, operation: "subject.check" },
});
